// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { api, type Machine, type Project, type SessionInfo, type SessionStatus, type Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { ACTIVITY_STATUS_KEY, GOAL_STATUS_KEY } from "../extensionStatusSnapshots";
import { DesktopNotificationController, NATIVE_NOTIFICATION_HOLDS_EVENT, NATIVE_NOTIFICATION_OPEN_EVENT } from "../controllers/desktopNotificationController";
import { DEFAULT_INTERFACE_SCALE, INTERFACE_SCALE_CSS_PROPERTY, INTERFACE_SCALE_STORAGE_KEY, readStoredInterfaceScale } from "../interfaceScale";
import { machineSessionKey } from "../machineKeys";
import { readStoredPresentationProfile } from "../presentationProfiles";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { clearStagedAttachments, saveStagedAttachments } from "../promptAttachmentStaging";
import { readStoredThemePreference } from "../theme";
import type { ChatView } from "./ChatView";
import { transcriptImageSource, type TranscriptImage } from "./TranscriptImage";
import { DelegateRoster } from "./DelegateRoster";
import type { FormattedText } from "./FormattedText";
import { GoalStatusChip } from "./GoalStatusChip";
import { PromptEditor } from "./PromptEditor";
import { WorkbenchApp, adHocWorkspace, rootProjectOf, rootProjects, sessionInfoText } from "./WorkbenchApp";
import { HttpRequestError } from "../api/http";
import type { WorkbenchFilesPane } from "./WorkbenchFilesPane";
import { EditorView } from "@codemirror/view";
import { WorkbenchSettingsPanel } from "./WorkbenchSettingsPanel";
import { WorkstreamContextDrawer } from "./WorkstreamContextDrawer";
import { WorkbenchChatPane } from "./WorkbenchChatPane";
import type { WorkbenchQuestionChips } from "./WorkbenchQuestionChips";
import { SessionController } from "../controllers/sessionController";
import { WINDOW_CHANNEL, WINDOW_ID_LOCK_PREFIX, WINDOW_STORE_KEY } from "../controllers/workbenchWindowController";
import { FakeLocks } from "../controllers/webLocks.testSupport";
import { moveChats, openChat, parseWindowStore } from "../workbenchWindows";

// Browser plugin modules load by URL import; serve the bundled Mermaid source instead.
vi.mock("../plugins/external", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/external")>();
  return { ...actual, loadExternalPlugins: (url: string, options: Parameters<typeof actual.loadExternalPlugins>[1] = {}) => actual.loadExternalPlugins(url, { ...options, moduleLoader: () => import("../../../../pi-web-plugins/mermaid/pi-web-plugin") }) };
});

/** happy-dom has no Web Locks; windows share their store only with them, as in a secure-context browser. */
let locks: FakeLocks;

beforeEach(() => {
  locks = new FakeLocks();
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
  vi.spyOn(api, "machines").mockResolvedValue([machine]);
  vi.spyOn(api, "projects").mockResolvedValue([]);
  // Session selection loads one transcript snapshot; compose it from the per-test messages/status/stream mocks.
  vi.spyOn(api, "transcriptSnapshot").mockImplementation(async (selected, options, machineId) => {
    const [page, status, stream] = await Promise.all([api.messages(selected, options, machineId), api.status(selected, machineId), api.streamSnapshot(selected, machineId)]);
    return { page, status, ...stream };
  });
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

/** Plain-http origins lack crypto.randomUUID; ids then come from getRandomValues, filled here with `byte`. */
function plainHttpRandomKey(byte: number): string {
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => { throw new TypeError("crypto.randomUUID is not a function"); });
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    if (array instanceof Uint8Array) array.fill(byte);
    return array;
  });
  return byte.toString(16).padStart(2, "0").repeat(16);
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "locks");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const stubSelectedChat = () => {
  vi.spyOn(api, "messages").mockResolvedValue({ messages: [], start: 0, total: 0 });
  vi.spyOn(api, "streamSnapshot").mockResolvedValue({ seq: 0, partial: null });
  vi.spyOn(api, "thinkingLevels").mockResolvedValue({ levels: [] });
  return vi.spyOn(api, "status").mockImplementation((ref) => Promise.resolve(idleStatus(ref.id)));
};
const openFromWorkstream = (app: WorkbenchApp, detail: Record<string, unknown>) => {
  app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("open-workstream-session", { detail: { workstreamId: "workstream", directories: [], ...detail } }));
};

const paneText = (pane: WorkbenchFilesPane | null | undefined): string | undefined => {
  const dom = pane?.shadowRoot?.querySelector<HTMLElement>(".cm-editor");
  return dom === null || dom === undefined ? undefined : EditorView.findFromDOM(dom)?.state.doc.toString();
};

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

  it("groups a sibling repository named `<project>-<suffix>` under that project", () => {
    const photo: Project = { ...project, id: "photo", name: "PhotoQuest", path: "/ideas/PhotoQuest" };
    const studio: Project = { ...project, id: "studio", name: "PhotoQuest-studio", path: "/ideas/PhotoQuest-studio" };
    const worktree: Project = { ...project, id: "wt", name: "PhotoQuest.eval", path: "/ideas/PhotoQuest.eval" };
    const deeper: Project = { ...project, id: "deeper", name: "x", path: "/ideas/PhotoQuest-studio-old/x" };
    const all = [studio, photo, worktree, deeper];
    expect(rootProjectOf(studio, all).id).toBe("photo");
    expect(rootProjectOf(worktree, all).id).toBe("wt");
    expect(rootProjectOf(deeper, all).id).toBe("deeper");
    expect(rootProjects(all).map((candidate) => candidate.id)).toEqual(["photo", "wt", "deeper"]);
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
    expect(app.shadowRoot?.querySelector(".files-toggle")?.getAttribute("title")).toBe("Files \u2014 nested (/outside/nested)");
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

  it("shows no Workstream drawer when no registered project can provide Workstream access, the Chat title staying on its tab", async () => {
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
    await vi.waitFor(() => { expect(Reflect.get(app, "currentWorkstreamError")).toContain("registered project"); expect(Reflect.get(app, "currentWorkstream")).toBeNull(); });
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector("workstream-context-drawer")).toBeNull();
    expect(chatTabs(app)).toEqual(["Nested chat"]);
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
    expect(app.shadowRoot?.querySelector('button[aria-label="New Chat without a project"] svg')).not.toBeNull();
    expect(app.shadowRoot?.querySelector('button[aria-label="Add project…"] svg')).not.toBeNull();
    app.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="New Chat without a project"]')?.dispatchEvent(new MouseEvent("click", { altKey: true }));
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("adhoc"); });
    expect(getState(app).selectedWorkspace?.path).toBe("/anywhere/notes");
    expect(window.location.search).toMatch(/^\?win=[^&]+&session=adhoc&view=chat$/u);

    document.body.replaceChildren();
    const reopened = new WorkbenchApp();
    document.body.append(reopened);
    await vi.waitFor(() => { expect(getState(reopened).selectedSession?.id).toBe("adhoc"); });
    expect(getState(reopened).selectedWorkspace?.path).toBe("/anywhere/notes");
    delete window.piWebNative;
  });

  it("starts a plain click's Chat in ~/IdeaProjects without opening the folder panel", async () => {
    const started = { ...session("ideas", ""), cwd: "/Users/me/IdeaProjects" };
    const start = vi.spyOn(api, "startSession").mockResolvedValue(started);
    vi.spyOn(api, "sessions").mockResolvedValue([]);
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: "ideas", persisted: false, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    vi.spyOn(api, "projectDirectories").mockResolvedValue([{ path: "/Users/me/IdeaProjects-old/", kind: "other" }, { path: "/Users/me/IdeaProjects/", kind: "other" }]);
    const pickDirectory = vi.fn(() => Promise.resolve("/elsewhere"));
    window.piWebNative = { pickDirectory, notify: () => Promise.resolve() };
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(Reflect.get(app, "loading")).toBe(false); });
    await app.updateComplete;
    app.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="New Chat without a project"]')?.click();
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("ideas"); });
    expect(start.mock.calls[0]?.[0]).toBe("/Users/me/IdeaProjects");
    expect(pickDirectory).not.toHaveBeenCalled();
    delete window.piWebNative;
  });

  it("explains a folder panel that never opened instead of failing silently", async () => {
    vi.spyOn(api, "projectDirectories").mockResolvedValue([]);
    window.piWebNative = { pickDirectory: () => Promise.reject(new Error("WKWebView API client did not respond to this postMessage")), notify: () => Promise.resolve() };
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(Reflect.get(app, "loading")).toBe(false); });
    await app.updateComplete;
    app.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="New Chat without a project"]')?.click();
    await vi.waitFor(() => { expect(getState(app).error).toContain("Quit and reopen Pi Workbench"); });
    delete window.piWebNative;
  });
});

describe("session info", () => {
  it("lists id, folder and transcript, and never invents a path for an unsaved Chat", () => {
    const saved = { ...session("abc", ""), cwd: "/work", path: "/store/abc.jsonl" };
    expect(sessionInfoText(saved)).toBe("Session: abc\nFolder: /work\nTranscript: /store/abc.jsonl");
    expect(sessionInfoText({ ...saved, path: "", persisted: false })).toContain("Transcript: not known yet");
  });

  it("shows the known transcript path of a new Chat, and trusts live status over the stale row", () => {
    const fresh = { ...session("abc", ""), cwd: "/work", path: "/store/abc.jsonl", persisted: false };
    expect(sessionInfoText(fresh)).toContain("Transcript: /store/abc.jsonl (written after the first reply)");
    const written: SessionStatus = { sessionId: "abc", persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
    expect(sessionInfoText(fresh, written)).toBe("Session: abc\nFolder: /work\nTranscript: /store/abc.jsonl");
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
    expect(Reflect.get(app, "revealTarget")).toBeUndefined();
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
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector<ChatView>("chat-view")?.revealTarget).toEqual({ machineId: "local", sessionId: "second", anchor: "ask:ask-1" });
  });

  it("reveals a notification's message from the opening URL once, and from the native app without a reload", async () => {
    const first = session("first", "First", "First Chat");
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    vi.spyOn(api, "sessions").mockResolvedValue([first]);
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], start: 0, total: 0 });
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: "first", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    vi.spyOn(api, "streamSnapshot").mockResolvedValue({ seq: 0, partial: null });
    window.history.replaceState({}, "", "/?session=first&message=entry%3Areply-1");
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("first"); });
    await app.updateComplete;
    const view = app.shadowRoot?.querySelector<ChatView>("chat-view");
    expect(view?.revealTarget).toEqual({ machineId: "local", sessionId: "first", anchor: "entry:reply-1" });
    expect(window.location.search).not.toContain("message");

    window.dispatchEvent(new CustomEvent("pi-web:notification-open", { detail: { machineId: "local", sessionId: "first", message: "dialog:d-1" } }));
    await vi.waitFor(() => { expect(app.shadowRoot?.querySelector<ChatView>("chat-view")?.revealTarget).toEqual({ machineId: "local", sessionId: "first", anchor: "dialog:d-1" }); });
    window.dispatchEvent(new CustomEvent("pi-web:notification-open", { detail: { machineId: "local", sessionId: "first", message: "bad anchor" } }));
    await vi.waitFor(() => { expect(app.shadowRoot?.querySelector<ChatView>("chat-view")?.revealTarget).toBeUndefined(); });
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
    await vi.waitFor(() => { expect(status.mock.calls.length).toBeGreaterThan(statusCalls); });
    await vi.waitFor(() => { expect(Reflect.get(app, "loading")).toBe(false); });
    expect(getState(app).selectedSession?.id).toBe(current.id);
    expect(app.shadowRoot?.querySelector('[data-view="chat"]')).not.toBeNull();
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

  it("scopes media-referenced transcript images to the Chat's session cwd and machine", async () => {
    const current = session("human", "See image");
    const app = await mountChooser([current]);
    const mediaId = "a".repeat(64);
    setState(app, { ...getState(app), selectedSession: current, messages: [{ role: "user", parts: [{ type: "image", mediaId, mimeType: "image/png", byteSize: 3 }] }] });
    await app.updateComplete;
    const chat = app.shadowRoot?.querySelector<ChatView>("chat-view");
    if (chat === null || chat === undefined) throw new Error("Chat was not rendered");
    await chat.updateComplete;
    const image = chat.renderRoot.querySelector<TranscriptImage>("pi-web-transcript-image");
    if (image?.imagePart === undefined) throw new Error("Transcript image was not rendered");
    const source = transcriptImageSource(image.imagePart, image.session, image.machineId);
    expect(source?.src).toContain(`/api/machines/local/sessions/human/media/${mediaId}?cwd=%2Frepo`);
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
    expect(toggle?.title).toBe("Files \u2014 Project \u00b7 main (/repo)");
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
    const close = app.shadowRoot?.querySelector<HTMLButtonElement>(".files-close");
    expect(close?.getAttribute("aria-label")).toBe("Close Files");
    close?.click();
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector("workbench-files-pane")).toBeNull();
    toggle?.click();
    await app.updateComplete;
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
    await vi.waitFor(() => { expect(paneText(app.shadowRoot?.querySelector("workbench-files-pane"))).toBe("body of docs/notes.md"); });
    expect(read).toHaveBeenCalledWith(project.id, workspace.id, "docs/notes.md", machine.id);
    const pane = app.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane");
    if (pane === undefined || pane === null) throw new Error("Files pane was not mounted");
    const canClose = vi.spyOn(pane, "canClose").mockReturnValue(false);
    click(anchors[1]);
    await vi.waitFor(() => { expect(canClose).toHaveBeenCalled(); });
    expect(read).toHaveBeenCalledTimes(1);
    canClose.mockReturnValue(true);
    click(anchors[1]);
    await vi.waitFor(() => { expect(paneText(pane)).toBe("body of .scratch/LEDGER.md"); });
    expect(anchors[2]?.getAttribute("data-outside-file")).toBe("/elsewhere/x.md");
    expect(click(anchors[2]).defaultPrevented).toBe(true);
    await vi.waitFor(() => { expect(paneText(pane)).toBe("body of x.md"); });
    expect(read).toHaveBeenLastCalledWith("", "folder:/elsewhere", "x.md", machine.id);
  });

  it("offers the enabled Mermaid plugin for mermaid fences in Chat", async () => {
    const manifest = { lifecycleVersion: 2, terminalMode: "recovery-disabled", plugins: [
      { id: "mermaid", module: "/pi-web-plugins/mermaid/browser/pi-web-plugin.js", source: "bundled", scope: "bundled", machineSpecific: false },
      { id: "files", module: "/pi-web-plugins/files/browser/pi-web-plugin.js", source: "bundled", scope: "bundled", machineSpecific: false },
    ] };
    const fetchMock = vi.fn((url: string) => Promise.resolve(url.endsWith("/pi-web-plugins/manifest.json")
      ? new Response(JSON.stringify(manifest), { status: 200 })
      : url.endsWith("/plugins") ? pluginLifecycleResponse() : new Response(JSON.stringify({ ok: true, value: [] }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const current = session("human", "Draw");
    const app = await mountChooser([current]);
    setState(app, { ...getState(app), selectedSession: current, messages: [{ role: "assistant", parts: [{ type: "text", text: "```mermaid\nflowchart LR\n  A --> B\n```" }] }] });
    await app.updateComplete;
    const chat = app.shadowRoot?.querySelector<ChatView>("chat-view");
    if (chat === null || chat === undefined) throw new Error("Chat was not rendered");
    await vi.waitFor(async () => {
      app.requestUpdate();
      await app.updateComplete;
      await chat.updateComplete;
      const text = chat.renderRoot.querySelector<FormattedText>("formatted-text");
      await text?.updateComplete;
      expect(text?.renderRoot.querySelector("pi-web-content-renderer")).not.toBeNull();
    });
    expect(chat.machineId).toBe(machine.id);
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
    await vi.waitFor(() => { expect(paneText(pane())).toBe("body of src/server/sessions/sessionNameGenerator.ts"); });
    expect(pane()?.workspace).toBe(siblingWorkspace);

    anchors[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, button: 0 }));
    await vi.waitFor(() => { expect(read).toHaveBeenLastCalledWith("", "folder:/loose", "notes.md", machine.id); });

    const toggle = app.shadowRoot?.querySelector<HTMLButtonElement>(".files-toggle");
    toggle?.click(); await app.updateComplete;
    toggle?.click(); await app.updateComplete;
    expect(pane()?.workspace).toBe(workspace);
  });

  it("opens workspace file search with Cmd+P or the Files pane button without remounting Chat", async () => {
    const current = session("human", "Edit notes");
    const app = await mountChooser([current]);
    setState(app, { ...getState(app), selectedSession: current });
    await app.updateComplete;
    const tree = vi.spyOn(api, "workspaceTree").mockResolvedValue({ path: "", entries: [], scannedAt: "now", truncated: false });
    const chat = app.shadowRoot?.querySelector("chat-view");
    const key = new KeyboardEvent("keydown", { key: "p", metaKey: true, cancelable: true });
    window.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    const ctrl = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true });
    window.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(false);
    const pane = () => app.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane");
    await vi.waitFor(() => { expect(pane()?.shadowRoot?.querySelector(".pane.tree-open")).not.toBeNull(); });
    await vi.waitFor(() => { expect(tree.mock.calls[0]?.slice(0, 4)).toEqual([project.id, workspace.id, "", "local"]); });
    await vi.waitFor(() => { expect(pane()?.shadowRoot?.activeElement).toBe(pane()?.shadowRoot?.querySelector('input[aria-label="Filter files"]')); });
    expect(app.shadowRoot?.querySelector("chat-view")).toBe(chat);
    expect(WorkbenchApp.styles.cssText).toMatch(/:is\(header, \.chat-tools\) > button\s*\{[^}]*min-height:\s*32px;[^}]*border-color:\s*transparent/);
    // Search lives in the Files pane toolbar, not the Chat header.
    expect(app.shadowRoot?.querySelector('header button[aria-label="Search files"]')).toBeNull();
    // happy-dom's ShadowRoot.activeElement throws while focus sits in another nested shadow root.
    pane()?.shadowRoot?.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')?.blur();
    pane()?.shadowRoot?.querySelector<HTMLButtonElement>('.bar button[aria-label="Search files"]')?.click();
    await vi.waitFor(() => { expect(pane()?.shadowRoot?.activeElement).toBe(pane()?.shadowRoot?.querySelector('input[aria-label="Filter files"]')); });
    pane()?.shadowRoot?.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')?.blur();
  });

  it("shows only this Chat's open questions as chips above its composer, answering through the session, with no Questions button or pane", async () => {
    const current = session("human", "Edit notes");
    const app = await mountChooser([current]);
    const openAsk = (askId: string) => ({ askId, askedAt: "2026-10-19T10:00:00.000Z", updatedAt: "2026-10-19T10:00:00.000Z", revision: "r1", turnsSinceUpdate: 0, context: "Why", questions: [{ id: "db", question: "Which database?", options: [] }] });
    setState(app, { ...getState(app), selectedSession: current, pendingAsks: [openAsk("abc-1"), openAsk("def-2")], sessionStatuses: { other: { ...idleStatus("other"), pendingAsks: [openAsk("xyz-9")] } } });
    await app.updateComplete;
    const chips = app.shadowRoot?.querySelector<WorkbenchQuestionChips>(".chat-column > workbench-question-chips");

    expect(chips?.nextElementSibling?.localName).toBe("prompt-editor");
    expect(chips?.asks.map((ask) => ask.askId)).toEqual(["abc-1", "def-2"]);
    expect(app.shadowRoot?.querySelector<ChatView>("chat-view")?.pendingAsks).toEqual([]);
    expect(app.shadowRoot?.querySelector(".questions-toggle, workbench-questions-pane, #workbench-questions")).toBeNull();
    expect(WorkbenchApp.styles.cssText).not.toContain("questions");
    // Each tile contains its size, so the question drawer can take 60% of the tile's height (cqh).
    expect(WorkbenchApp.styles.cssText).toMatch(/\.tile \{ container-type: size; \}/);

    const submit = vi.spyOn(api, "submitAsk").mockResolvedValue({ result: "closed", sessionStatus: idleStatus(current.id) });
    await chips?.onSubmit?.("def-2", { answers: [{ id: "db", values: [], otherText: "Postgres" }], revision: "r1" });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ id: current.id }), "def-2", { answers: [{ id: "db", values: [], otherText: "Postgres" }], revision: "r1" }, "local");

    setState(app, { ...getState(app), pendingAsks: [] });
    await app.updateComplete;
    expect(chips?.asks).toEqual([]);
  });

  it("keeps Files in the side slot with its divider, width and close chevron", async () => {
    const current = session("human", "Edit notes");
    const app = await mountChooser([current]);
    setState(app, { ...getState(app), selectedSession: current });
    await app.updateComplete;
    const container = app.shadowRoot?.querySelector<HTMLElement>(".chat-and-files");
    if (!container) throw new Error("Missing Chat container");
    Object.defineProperty(container, "clientWidth", { configurable: true, value: 1000 });
    const $ = (selector: string) => app.shadowRoot?.querySelector(selector) ?? null;
    const click = async (selector: string) => { app.shadowRoot?.querySelector<HTMLButtonElement>(selector)?.click(); await app.updateComplete; };

    await click(".files-toggle");
    expect($("workbench-files-pane")).not.toBeNull();
    const divider = $(".files-divider");
    expect(divider?.getAttribute("aria-label")).toBe("Resize Files pane");
    expect(divider?.getAttribute("aria-controls")).toBe("workbench-files");
    expect($(".files-close")?.getAttribute("aria-label")).toBe("Close Files");
    expect($(".files-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(WorkbenchApp.styles.cssText).toMatch(/workbench-files-pane \{ flex: 0 0 min\(var\(--files-width\)/);
    divider?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    await app.updateComplete;
    expect($(".files-divider")?.getAttribute("aria-valuenow")).toBe("424");

    const files = app.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane");
    if (!files) throw new Error("Files pane was not mounted");
    const canClose = vi.spyOn(files, "canClose").mockReturnValue(false);
    await click(".files-close");
    expect($("workbench-files-pane")).toBe(files);
    canClose.mockReturnValue(true);
    await click(".files-close");
    expect($("workbench-files-pane")).toBeNull();
    expect($(".files-divider")).toBeNull();
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

    app.shadowRoot?.querySelector("workbench-window-tabs")?.dispatchEvent(new CustomEvent("window-home"));
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

  it("opens an unanchored legacy blank Workstream Chat through targeted discovery without loading the whole workspace catalog", async () => {
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
    expect(sessions.mock.calls).toEqual([[workspace.path, "local", { sessionId: "continued" }]]);
  });

  it("uses authoritative archived metadata for an unanchored Workstream Chat", async () => {
    const archived: SessionInfo = { ...session("unanchored-archive", "Stored title"), archived: true };
    const app = await mountChooser([]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    const listed = vi.spyOn(api, "sessions").mockResolvedValue([archived]);
    const status = stubSelectedChat();

    openFromWorkstream(app, { sessionId: archived.id });

    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(archived.id); });
    await app.updateComplete;
    expect(getState(app).selectedSession).toEqual(archived);
    expect(listed).toHaveBeenCalledWith(workspace.path, "local", { sessionId: archived.id });
    expect(status).not.toHaveBeenCalled();
    expect(promptEditor(app).disabled).toBe(true);
  });

  it("a newer Workstream open supersedes an older lookup on the same machine", async () => {
    const app = await mountChooser([]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const first = deferred<SessionInfo[]>();
    const secondRow = session("second-open", "Newer choice");
    const listed = vi.spyOn(api, "sessions").mockImplementation((_cwd, _machine, options) => options?.sessionId === "first-open" ? first.promise : Promise.resolve([secondRow]));
    stubSelectedChat();

    openFromWorkstream(app, { sessionId: "first-open", projectId: project.id, workspaceId: workspace.id });
    await vi.waitFor(() => { expect(listed).toHaveBeenCalledWith(workspace.path, "local", { sessionId: "first-open" }); });
    openFromWorkstream(app, { sessionId: secondRow.id, projectId: project.id, workspaceId: workspace.id });
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(secondRow.id); });
    first.resolve([session("first-open", "Superseded choice")]);
    await new Promise<void>((resolve) => { window.setTimeout(resolve, 0); });
    expect(getState(app).selectedSession?.id).toBe(secondRow.id);
  });

  it("drops a superseded Workstream locate error after a machine switch", async () => {
    const app = await mountChooser([]);
    const remote: Machine = { ...machine, id: "remote", name: "Remote", kind: "remote" };
    setState(app, { ...getState(app), machines: [machine, remote] });
    const located = deferred<{ cwd: string }>();
    const locate = vi.spyOn(api, "locate").mockReturnValue(located.promise);

    openFromWorkstream(app, { sessionId: "old-open" });
    await vi.waitFor(() => { expect(locate).toHaveBeenCalledWith("old-open", "local"); });
    const choose: unknown = Reflect.get(app, "chooseMachine");
    if (typeof choose !== "function") throw new Error("chooseMachine missing");
    await Reflect.apply(choose, app, [remote.id]);
    located.reject(new Error("Old machine lookup failed"));
    await new Promise<void>((resolve) => { window.setTimeout(resolve, 0); });
    expect(getState(app).selectedMachine?.id).toBe(remote.id);
    expect(getState(app).error).toBe("");
  });

  it("opens a rebound Workstream session in its registered sibling worktree", async () => {
    const worktree: Workspace = { ...workspace, id: "persistent-worktree", path: "/ideas/pi-workbench.context-views-20260909", label: "context views" };
    vi.spyOn(api, "sessions").mockResolvedValue([{ ...session("rebound", "Rebound"), cwd: worktree.path }]);
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
    const key = plainHttpRandomKey(1);
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
      idempotencyKey: `pi-web:${key}:pending`,
      records: [{
        type: "session.pending",
        producer: "pi-web",
        sourceSessionId: "previous",
        payload: { associationKey: `pi-web:${key}`, derivationKind: "checkpoint", machineId: "local", projectId: "project", workspaceId: "workspace" },
      }],
    });
    expect(confirmed).toEqual({
      workstreamId: "workstream",
      expectedRevision: 71,
      idempotencyKey: `pi-web:${key}:confirmed`,
      records: [{
        type: "session.confirmed",
        producer: "pi-web",
        sourceSessionId: "new-session",
        payload: { sessionId: "new-session", associationKey: `pi-web:${key}`, machineId: "local", projectId: "project", workspaceId: "workspace" },
      }],
    });
    expect(startSession).toHaveBeenCalledWith(workspace.path, "local", `pi-web:${key}`);
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
    const key = plainHttpRandomKey(3);
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
    expect(startSession).toHaveBeenCalledWith(workspace.path, "local", `pi-web:${key}`);
    expect(calls.find((call) => call.operation === "append")?.input).toMatchObject({
      records: [{ payload: {
        associationKey: `pi-web:${key}`,
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
    const key = plainHttpRandomKey(2);
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
      records: [{ sourceSessionId: "previous", payload: { associationKey: `pi-web:${key}`, derivationKind: "checkpoint" } }],
    });
    const records = calls.find((call) => call.operation === "append")?.input["records"];
    if (!Array.isArray(records) || typeof records[0] !== "object" || records[0] === null) throw new Error("pending record missing");
    const pendingPayload: unknown = Reflect.get(records[0], "payload");
    expect(pendingPayload).not.toHaveProperty("machineId");
    expect(pendingPayload).not.toHaveProperty("projectId");
    expect(pendingPayload).not.toHaveProperty("workspaceId");
  });
});

describe("Workbench request waterfalls", () => {
  const chatUrl = (id: string) => `/?project=${project.id}&workspace=${workspace.id}&session=${id}&view=chat`;

  it("UI-001: opens an archived anchored Workstream Chat from its recorded workspace's listed row without status, locating, or scanning projects", async () => {
    const sibling: Project = { ...project, id: "sibling", name: "Sibling", path: "/sibling" };
    const archived: SessionInfo = { ...session("anchored", "Old work", "Named"), archived: true };
    const locate = vi.spyOn(api, "locate");
    const workspaces = vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const sessions = vi.spyOn(api, "sessions").mockResolvedValue([session("other", "Other"), archived]);
    const status = stubSelectedChat();
    const app = await mountChooser([]);
    setState(app, { ...getState(app), projects: [project, sibling] });
    workspaces.mockClear();
    sessions.mockClear();

    openFromWorkstream(app, { sessionId: "anchored", projectId: project.id, workspaceId: workspace.id });

    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("anchored"); });
    await app.updateComplete;
    expect(getState(app).selectedSession).toEqual(archived);
    expect(status).not.toHaveBeenCalled();
    expect(locate).not.toHaveBeenCalled();
    expect(workspaces.mock.calls).toEqual([[project.id, "local"]]);
    // The targeted row opens the Chat; the whole catalog follows behind it.
    await vi.waitFor(() => { expect(sessions.mock.calls).toEqual([[workspace.path, "local", { sessionId: "anchored" }], [workspace.path, "local"]]); });
    expect(getState(app).selectedProject?.id).toBe(project.id);
    expect(getState(app).selectedWorkspace?.id).toBe(workspace.id);
    expect(promptEditor(app).disabled).toBe(true);
  });

  it("UI-001: opens a blank anchored Workstream Chat missing from the catalog through status in its recorded workspace", async () => {
    const locate = vi.spyOn(api, "locate");
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "sessions").mockResolvedValue([]);
    const status = stubSelectedChat();
    const app = await mountChooser([]);

    openFromWorkstream(app, { sessionId: "blank", projectId: project.id, workspaceId: workspace.id });

    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("blank"); });
    expect(locate).not.toHaveBeenCalled();
    expect(status.mock.calls[0]).toEqual([{ id: "blank", cwd: workspace.path }, "local"]);
    expect(getState(app).selectedWorkspace?.id).toBe(workspace.id);
  });

  it("UI-001: drops a late anchored row after the owner switched to another machine", async () => {
    const remote: Machine = { ...machine, id: "remote", name: "Remote", kind: "remote" };
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const targeted = deferred<SessionInfo[]>();
    const sessions = vi.spyOn(api, "sessions").mockImplementation((_cwd, _machineId, options) => options?.sessionId === undefined ? Promise.resolve([]) : targeted.promise);
    stubSelectedChat();
    const app = await mountChooser([]);
    setState(app, { ...getState(app), machines: [machine, remote] });

    openFromWorkstream(app, { sessionId: "anchored", projectId: project.id, workspaceId: workspace.id });
    await vi.waitFor(() => { expect(sessions).toHaveBeenCalledWith(workspace.path, "local", { sessionId: "anchored" }); });
    const chooseMachine: unknown = Reflect.get(app, "chooseMachine");
    if (typeof chooseMachine !== "function") throw new Error("chooseMachine missing");
    await Reflect.apply(chooseMachine, app, [remote.id]);
    targeted.resolve([session("anchored", "Local work")]);
    await new Promise<void>((resolve) => { window.setTimeout(resolve, 0); });

    expect(getState(app).selectedMachine?.id).toBe(remote.id);
    expect(getState(app).selectedSession).toBeUndefined();
    expect(getState(app).sessions).toEqual([]);
    expect(getState(app).selectedWorkspace).toBeUndefined();
  });

  it("UI-001: keeps a current daemon's anchored not-found authoritative at the located folder instead of rebuilding a writable Chat from status", async () => {
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    const sessions = vi.spyOn(api, "sessions").mockRejectedValue(new HttpRequestError("Session not found", 404));
    const status = stubSelectedChat();
    const app = await mountChooser([]);
    sessions.mockClear();

    openFromWorkstream(app, { sessionId: "archived", projectId: project.id, workspaceId: workspace.id });

    await vi.waitFor(() => { expect(getState(app).error).toContain("unavailable"); });
    expect(getState(app).selectedSession).toBeUndefined();
    expect(status).not.toHaveBeenCalled();
    expect(sessions.mock.calls).toEqual([[workspace.path, "local", { sessionId: "archived" }], [workspace.path, "local", { sessionId: "archived" }]]);
  });

  it("UI-001: opens an anchored Chat that moved from its located folder's targeted row, archived and read-only", async () => {
    const worktree: Workspace = { ...workspace, id: "worktree", path: "/repo-worktree", label: "worktree", isMain: false };
    const moved: SessionInfo = { ...session("moved", "Old work"), cwd: worktree.path, archived: true };
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace, worktree]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: worktree.path });
    vi.spyOn(api, "sessions").mockImplementation((cwd) => cwd === worktree.path ? Promise.resolve([moved]) : Promise.reject(new HttpRequestError("Session not found", 404)));
    const status = stubSelectedChat();
    const app = await mountChooser([]);

    openFromWorkstream(app, { sessionId: "moved", projectId: project.id, workspaceId: workspace.id });

    await vi.waitFor(() => { expect(getState(app).selectedSession).toEqual(moved); });
    await app.updateComplete;
    expect(getState(app).selectedWorkspace?.id).toBe(worktree.id);
    expect(status).not.toHaveBeenCalled();
    expect(promptEditor(app).disabled).toBe(true);
  });

  it.each([
    { case: "the recorded project is gone", projectId: "deleted", workspaceId: "workspace" },
    { case: "the recorded workspace is gone", projectId: "project", workspaceId: "gone" },
    { case: "the Chat is not in the recorded workspace", projectId: "project", workspaceId: "workspace" },
  ])("UI-001: falls back to locating a Workstream Chat when $case, never selecting another listed Chat", async ({ projectId, workspaceId }) => {
    const worktree: Workspace = { ...workspace, id: "worktree", path: "/repo-worktree", label: "worktree", isMain: false };
    const locate = vi.spyOn(api, "locate").mockResolvedValue({ cwd: worktree.path });
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace, worktree]);
    vi.spyOn(api, "sessions").mockResolvedValue([session("other", "Wrong Chat")]);
    stubSelectedChat().mockImplementation((ref) => ref.cwd === worktree.path ? Promise.resolve(idleStatus(ref.id)) : Promise.reject(new Error("Session not found")));
    const app = await mountChooser([]);

    openFromWorkstream(app, { sessionId: "moved", projectId, workspaceId });

    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("moved"); });
    expect(locate).toHaveBeenCalledWith("moved", "local");
    expect(getState(app).selectedSession?.cwd).toBe(worktree.path);
    expect(getState(app).selectedWorkspace?.id).toBe(worktree.id);
  });

  it("UI-001: lists fallback projects in parallel, preferring the deepest registered project", async () => {
    const outer: Project = { ...project, id: "outer", name: "Outer", path: "/ideas" };
    const inner: Project = { ...project, id: "inner", name: "Inner", path: "/ideas/inner" };
    const shared: Workspace = { ...workspace, id: "shared", projectId: inner.id, path: "/ideas/inner-wt", isMain: false };
    vi.spyOn(api, "sessions").mockResolvedValue([{ ...session("unanchored", "Located"), cwd: shared.path }]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: shared.path });
    const listings = new Map<string, Deferred<Workspace[]>>();
    const workspaces = vi.spyOn(api, "workspaces").mockImplementation((projectId) => {
      const listing = deferred<Workspace[]>();
      listings.set(projectId, listing);
      return listing.promise;
    });
    stubSelectedChat();
    const app = await mountChooser([]);
    setState(app, { ...getState(app), projects: [project, outer, inner] });
    workspaces.mockClear();

    openFromWorkstream(app, { sessionId: "unanchored" });

    await vi.waitFor(() => { expect(workspaces).toHaveBeenCalledTimes(3); });
    listings.get(project.id)?.resolve([workspace]);
    listings.get(outer.id)?.resolve([{ ...shared, projectId: outer.id }]);
    listings.get(inner.id)?.resolve([shared]);
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("unanchored"); });
    expect(getState(app).selectedProject?.id).toBe(inner.id);
  });

  // Targeted rows answer immediately; the whole-workspace catalog is held back so the Chat can only open from the targeted row.
  const splitSessions = (targeted: (id: string) => Promise<SessionInfo[]>, catalog: () => Promise<SessionInfo[]>) =>
    vi.spyOn(api, "sessions").mockImplementation((_cwd, _machineId, options) => options?.sessionId === undefined ? catalog() : targeted(options.sessionId));
  // Counted explicitly, so a query change cannot pass a held-back full catalog off as a targeted request.
  const catalogCalls = (sessions: ReturnType<typeof splitSessions>) => sessions.mock.calls.filter((call) => call[2]?.sessionId === undefined).length;
  const targetedCalls = (sessions: ReturnType<typeof splitSessions>) => sessions.mock.calls.filter((call) => call[2]?.sessionId !== undefined).length;

  it.each([
    { case: "an archived", row: { ...session("listed", "Old work", "Named Chat"), archived: true }, daemon: "current" },
    { case: "an active", row: session("listed", "Keep going", "Named Chat"), daemon: "current" },
    { case: "an archived", row: { ...session("listed", "Old work", "Named Chat"), archived: true }, daemon: "older" },
  ])("UI-002: opens $case Chat URL from its $daemon daemon's targeted row while the full catalog is still pending", async ({ row, daemon }) => {
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const catalog = deferred<SessionInfo[]>();
    // An older daemon ignores the id and answers the targeted request with its whole catalog.
    const sessions = splitSessions(() => Promise.resolve(daemon === "older" ? [session("other", "Wrong Chat"), row] : [row]), () => catalog.promise);
    const status = stubSelectedChat();
    const effects = [
      vi.spyOn(api, "prompt").mockResolvedValue({ accepted: true }),
      vi.spyOn(api, "commands").mockResolvedValue([]),
      vi.spyOn(api, "runCommand").mockResolvedValue({ type: "done" }),
      vi.spyOn(api, "navigateTree"),
      vi.spyOn(api, "forkTree"),
    ];
    window.history.replaceState({}, "", chatUrl(row.id));
    const app = new WorkbenchApp();
    document.body.append(app);

    await vi.waitFor(() => { expect(getState(app).selectedSession).toEqual(row); });
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector('[data-view="chat"]')).not.toBeNull();
    expect(promptEditor(app).disabled).toBe(row.archived === true);
    expect(catalogCalls(sessions)).toBe(1);
    expect(targetedCalls(sessions)).toBe(1);
    expect(sessions.mock.calls[0]).toEqual([workspace.path, "local", { sessionId: row.id }]);
    if (row.archived === true) {
      expect(status).not.toHaveBeenCalled();
      for (const effect of effects) expect(effect).not.toHaveBeenCalled();
    }

    catalog.resolve([session("other", "Wrong Chat"), row]);
    await vi.waitFor(() => { expect(getState(app).sessions.map((candidate) => candidate.id).sort()).toEqual(["listed", "other"]); });
    expect(getState(app).selectedSession).toEqual(row);
    expect(catalogCalls(sessions)).toBe(1);
  });

  it("UI-002: opens a project-less Chat URL from its located folder's targeted row before that folder's catalog", async () => {
    const row: SessionInfo = { ...session("adhoc", "Notes"), cwd: "/anywhere/notes", archived: true };
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: row.cwd });
    const sessions = splitSessions(() => Promise.resolve([row]), () => deferred<SessionInfo[]>().promise);
    const status = stubSelectedChat();
    window.history.replaceState({}, "", `/?session=${row.id}&view=chat`);
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).selectedSession).toEqual(row); });
    expect(getState(app).selectedWorkspace?.path).toBe(row.cwd);
    expect(status).not.toHaveBeenCalled();
    expect(catalogCalls(sessions)).toBe(1);
  });

  it("UI-002: reports a current daemon's explicit not-found without bootstrapping the Chat from status", async () => {
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    splitSessions(() => Promise.reject(new HttpRequestError("Session not found", 404)), () => Promise.resolve([]));
    const status = stubSelectedChat();
    window.history.replaceState({}, "", chatUrl("gone"));
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).error).toContain("no longer available"); });
    expect(getState(app).selectedSession).toBeUndefined();
    expect(status).not.toHaveBeenCalled();
  });

  it("UI-002: keeps the selected blank Chat and its live title when the delayed catalog arrives", async () => {
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const blank: SessionInfo = { ...session("blank", ""), path: "", persisted: false, messageCount: 0 };
    const catalog = deferred<SessionInfo[]>();
    splitSessions(() => Promise.resolve([blank]), () => catalog.promise);
    stubSelectedChat();
    window.history.replaceState({}, "", chatUrl(blank.id));
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(blank.id); });
    expect(promptEditor(app).disabled).toBe(false);
    const live = { ...blank, name: "Live title" };
    setState(app, { ...getState(app), sessions: getState(app).sessions.map((candidate) => candidate.id === blank.id ? live : candidate) });

    catalog.resolve([session("other", "Older Chat")]);
    await vi.waitFor(() => { expect(getState(app).sessions.map((candidate) => candidate.id)).toEqual(["blank", "other"]); });
    expect(getState(app).sessions[0]).toEqual(live);
    expect(getState(app).selectedSession?.id).toBe(blank.id);
  });

  it("UI-002: keeps an unselected new blank Chat with a saved draft, but not a stale persisted row, when the delayed catalog arrives", async () => {
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const row = session("listed", "Keep going");
    const catalog = deferred<SessionInfo[]>();
    splitSessions(() => Promise.resolve([row]), () => catalog.promise);
    stubSelectedChat();
    window.history.replaceState({}, "", chatUrl(row.id));
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(row.id); });
    const blank: SessionInfo = { ...session("new-blank", ""), path: "", persisted: false, messageCount: 0 };
    const stale = session("deleted", "Gone");
    saveDraft(machineSessionKey("local", blank.id), "Unsent idea");
    setState(app, { ...getState(app), sessions: [blank, stale, ...getState(app).sessions] });

    catalog.resolve([row, session("other", "Older Chat")]);
    await vi.waitFor(() => { expect(getState(app).sessions.map((candidate) => candidate.id)).toEqual(["new-blank", "listed", "other"]); });
    expect(getState(app).sessions[0]).toEqual(blank);
    expect(loadDraft(machineSessionKey("local", blank.id))).toBe("Unsent idea");
    expect(getState(app).selectedSession?.id).toBe(row.id);
  });

  it("UI-002: applies the delayed catalog's archive to the open Chat, read-only, keeping its live title and draft", async () => {
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const row = session("listed", "Keep going", "Old title");
    const catalog = deferred<SessionInfo[]>();
    splitSessions(() => Promise.resolve([row]), () => catalog.promise);
    stubSelectedChat();
    window.history.replaceState({}, "", chatUrl(row.id));
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(row.id); });
    await app.updateComplete;
    expect(promptEditor(app).disabled).toBe(false);
    const live = { ...row, name: "Live title" };
    saveDraft(machineSessionKey("local", row.id), "Half written");
    setState(app, { ...getState(app), sessions: [live], selectedSession: live });

    catalog.resolve([{ ...row, archived: true, archivedAt: "2026-09-01T00:00:00.000Z" }]);
    await vi.waitFor(() => { expect(getState(app).selectedSession?.archived).toBe(true); });
    await app.updateComplete;
    const archivedLive = { ...live, archived: true, archivedAt: "2026-09-01T00:00:00.000Z" };
    expect(getState(app).sessions).toEqual([archivedLive]);
    expect(getState(app).selectedSession).toEqual(archivedLive);
    expect(promptEditor(app).disabled).toBe(true);
    expect(loadDraft(machineSessionKey("local", row.id))).toBe("Half written");
  });

  it("UI-002: ignores a late catalog after the owner chose another workspace", async () => {
    const feature: Workspace = { ...workspace, id: "feature", path: "/repo-feature", label: "feature", isMain: false };
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace, feature]);
    const late = deferred<SessionInfo[]>();
    const row = session("listed", "Keep going");
    vi.spyOn(api, "sessions").mockImplementation((cwd, _machineId, options) => options?.sessionId !== undefined ? Promise.resolve([row])
      : cwd === workspace.path ? late.promise : Promise.resolve([{ ...session("feature-chat", "Feature"), cwd: feature.path }]));
    stubSelectedChat();
    window.history.replaceState({}, "", chatUrl(row.id));
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(row.id); });

    const chooseWorkspace: unknown = Reflect.get(app, "chooseWorkspace");
    if (typeof chooseWorkspace !== "function") throw new Error("chooseWorkspace missing");
    await Reflect.apply(chooseWorkspace, app, [feature.id]);
    late.resolve([row, session("stale", "Stale")]);
    await new Promise<void>((resolve) => { window.setTimeout(resolve, 0); });
    expect(getState(app).selectedWorkspace?.id).toBe(feature.id);
    expect(getState(app).sessions.map((candidate) => candidate.id)).toEqual(["feature-chat"]);
  });

  it("UI-002: ignores a late targeted row after navigation moved to another Chat, in each of two windows", async () => {
    // Both shells live in one document; without Web Locks neither proves the other alive, so neither routes the other's Chat.
    Reflect.deleteProperty(navigator, "locks");
    onTestFinished(() => { sessionStorage.clear(); });
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const first = deferred<SessionInfo[]>();
    const second = session("second", "Second");
    splitSessions((id) => id === "first" ? first.promise : Promise.resolve([second]), () => Promise.resolve([session("first", "First"), second]));
    stubSelectedChat();
    window.history.replaceState({}, "", chatUrl("first"));
    const app = new WorkbenchApp();
    document.body.append(app);
    window.history.replaceState({}, "", chatUrl(second.id));
    const other = new WorkbenchApp();
    document.body.append(other);
    await vi.waitFor(() => { expect(getState(other).selectedSession?.id).toBe(second.id); });
    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(second.id); });

    first.resolve([session("first", "First")]);
    await new Promise<void>((resolve) => { window.setTimeout(resolve, 0); });
    expect(getState(app).selectedSession?.id).toBe(second.id);
    expect(getState(other).selectedSession?.id).toBe(second.id);
    expect(getState(app).sessions.map((candidate) => candidate.id).sort()).toEqual(["first", "second"]);
  });

  it("UI-002: reports a complete Chat URL that neither status nor the list can serve", async () => {
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "sessions").mockResolvedValue([]);
    vi.spyOn(api, "status").mockRejectedValue(new Error("Session not found"));
    window.history.replaceState({}, "", chatUrl("missing"));
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).error).toContain("no longer available"); });
    expect(getState(app).selectedSession).toBeUndefined();
  });

  it("UI-003: restores a saved non-main workspace with exactly one session list request", async () => {
    const feature: Workspace = { ...workspace, id: "feature", path: "/repo-feature", label: "feature", isMain: false };
    localStorage.setItem("pi-workbench.last-workspace", JSON.stringify({ machineId: "local", projectId: project.id, workspaceId: feature.id }));
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace, feature]);
    const sessions = vi.spyOn(api, "sessions").mockResolvedValue([]);
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).selectedWorkspace?.id).toBe(feature.id); expect(Reflect.get(app, "loading")).toBe(false); });
    expect(sessions.mock.calls).toEqual([[feature.path, "local"]]);
  });

  it("UI-006: starts a Workstream Chat in a loaded workspace without listing projects, recording pending before start", async () => {
    const sibling: Project = { ...project, id: "sibling", name: "Sibling", path: "/sibling" };
    const protocol: string[] = [];
    const calls: WorkstreamServiceCall[] = [];
    stubWorkstreamService(calls, (body) => {
      if (body.operation === "inspect") return { ok: true, value: { id: "workstream", revision: 1, sessions: [], humanTasks: [] } };
      protocol.push(body.operation);
      return { ok: true, value: body.operation === "watch" ? { mode: "replay", events: [], nextSequence: 1 } : { acceptedRevision: 2 } };
    }, protocol);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    const workspaces = vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "startSession").mockImplementation(() => { protocol.push("start"); return Promise.resolve(session("new-session", "")); });
    vi.spyOn(api, "runCommand").mockResolvedValue({ type: "done" });
    const app = await mountChooser([]);
    setState(app, { ...getState(app), projects: [project, sibling] });
    workspaces.mockClear();

    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("start-workstream-session", { detail: { workstreamId: "workstream", sessionId: "previous", directories: [] } }));

    await vi.waitFor(() => { expect(calls.filter((call) => call.operation === "append")).toHaveLength(2); });
    expect(workspaces).not.toHaveBeenCalled();
    expect(protocol.slice(0, 3)).toEqual(["inspect", "append", "start"]);
    expect(calls.find((call) => call.operation === "append")?.input).toMatchObject({ records: [{ payload: { machineId: "local", projectId: project.id, workspaceId: workspace.id } }] });
    expect(getState(app).selectedProject?.id).toBe(project.id);
  });

  it("UI-006: discovers an unloaded Workstream directory's registered workspace before recording pending", async () => {
    const sibling: Project = { ...project, id: "sibling", name: "Sibling", path: "/sibling" };
    const siblingWorkspace: Workspace = { ...workspace, id: "sibling-main", projectId: sibling.id, path: sibling.path };
    const protocol: string[] = [];
    const calls: WorkstreamServiceCall[] = [];
    stubWorkstreamService(calls, (body) => {
      if (body.operation === "inspect") return { ok: true, value: { id: "workstream", revision: 1, sessions: [], humanTasks: [] } };
      protocol.push(body.operation);
      return { ok: true, value: body.operation === "watch" ? { mode: "replay", events: [], nextSequence: 1 } : { acceptedRevision: 2 } };
    }, protocol);
    vi.spyOn(api, "workspaces").mockImplementation((projectId) => Promise.resolve(projectId === sibling.id ? [siblingWorkspace] : [workspace]));
    const start = vi.spyOn(api, "startSession").mockImplementation(() => { protocol.push("start"); return Promise.resolve({ ...session("new-session", ""), cwd: sibling.path }); });
    vi.spyOn(api, "runCommand").mockResolvedValue({ type: "done" });
    const app = await mountChooser([]);
    setState(app, { ...getState(app), projects: [project, sibling] });

    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("start-workstream-session", { detail: { workstreamId: "workstream", directories: [sibling.path], sessionId: "previous" } }));

    await vi.waitFor(() => { expect(calls.filter((call) => call.operation === "append")).toHaveLength(2); });
    expect(protocol.slice(0, 3)).toEqual(["inspect", "append", "start"]);
    expect(start).toHaveBeenCalledWith(sibling.path, "local", expect.stringMatching(/^pi-web:/));
    expect(calls.find((call) => call.operation === "append")?.input).toMatchObject({ records: [{ payload: { projectId: sibling.id, workspaceId: siblingWorkspace.id } }] });
  });

  it("UI-009: returns through browser Back to another Chat without reloading machines, projects, or the realtime socket", async () => {
    const first = session("first", "First");
    const second = session("second", "Second");
    const opened: string[] = [];
    vi.stubGlobal("WebSocket", class extends SilentWebSocket { constructor(url: string) { super(); opened.push(url); } });
    const projects = vi.spyOn(api, "projects").mockResolvedValue([project]);
    const workspaces = vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "sessions").mockResolvedValue([first, second]);
    stubSelectedChat();
    window.history.replaceState({}, "", chatUrl(first.id));
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(first.id); expect(Reflect.get(app, "loading")).toBe(false); });
    const realtimeSockets = () => opened.filter((url) => url.endsWith("/api/machines/local/events")).length;
    expect(realtimeSockets()).toBe(1);
    const machines = vi.mocked(api.machines);
    machines.mockClear();
    projects.mockClear();
    workspaces.mockClear();

    window.history.pushState({}, "", chatUrl(second.id));
    window.dispatchEvent(new PopStateEvent("popstate"));

    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(second.id); expect(Reflect.get(app, "loading")).toBe(false); });
    expect(machines).not.toHaveBeenCalled();
    expect(projects).not.toHaveBeenCalled();
    expect(workspaces).toHaveBeenCalledOnce();
    expect(realtimeSockets()).toBe(1);
  });

  it("WS-006: reloads the open Workstream header only for events about its Workstream or Chat", async () => {
    const current = session("current", "Chat", "Named chat");
    let nextSequence = 5;
    let events: unknown[] = [];
    const calls: WorkstreamServiceCall[] = [];
    stubWorkstreamService(calls, ({ operation }) => operation === "watch"
      ? { ok: true, value: { mode: "replay", events, nextSequence } }
      : operation === "list" ? { ok: true, value: [{ id: "mine" }] }
      : { ok: true, value: { id: "mine", title: "Mine", revision: 1, sessions: [{ id: current.id, status: "active" }], humanTasks: [], links: [], overview: null, closed: false } }, undefined, true);
    stubSelectedChat();
    const app = await mountChooser([current]);
    app.shadowRoot?.querySelector<HTMLButtonElement>(".session")?.click();
    await vi.waitFor(() => { expect(Reflect.get(app, "currentWorkstream")).toMatchObject({ id: "mine" }); });
    await vi.waitFor(() => { expect(Reflect.get(app, "workstreamWatchTimer")).toBeDefined(); });
    const timer: unknown = Reflect.get(app, "workstreamWatchTimer");
    if (typeof timer === "number") window.clearTimeout(timer);
    const reloads = () => calls.filter((call) => call.operation === "list").length;
    const event = (sequence: number, workstreamId: string, records: unknown[] = [{ type: "title.set" }]) => ({ sequence, workstreamId, revision: sequence, records, recordedAt: "2026-10-05T00:00:00.000Z" });
    const loaded = reloads();
    vi.useFakeTimers();
    try {
      const schedule: unknown = Reflect.get(app, "scheduleWorkstreamWatch");
      if (typeof schedule !== "function") throw new Error("Watch scheduler missing");
      Reflect.apply(schedule, app, [{ machineId: "local", projectId: "project", workspaceId: "workspace" }, current.id]);

      events = [event(6, "foreign")];
      nextSequence = 6;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reloads()).toBe(loaded);

      events = [event(7, "foreign", [{ type: "session.confirmed", payload: { sessionId: current.id } }])];
      nextSequence = 7;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reloads()).toBe(loaded + 1);

      events = [event(8, "mine")];
      nextSequence = 8;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reloads()).toBe(loaded + 2);
    } finally { app.remove(); vi.useRealTimers(); }
  });
});

// Independent review repros for targeted Workstream opens racing chooser navigation, machine switches, and each other.
describe("Workstream open versus in-flight navigation", () => {
  const remote: Machine = { ...machine, id: "remote", name: "Remote", kind: "remote" };
  const chatUrl = (id: string) => `/?project=${project.id}&workspace=${workspace.id}&session=${id}&view=chat`;
  const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => { window.setTimeout(resolve, 0); }); };
  const call = async (app: WorkbenchApp, name: string, ...args: unknown[]): Promise<void> => {
    const fn: unknown = Reflect.get(app, name);
    if (typeof fn !== "function") throw new Error(`${name} missing`);
    await Promise.resolve(Reflect.apply(fn, app, args));
  };
  const loadingText = (app: WorkbenchApp) => app.shadowRoot?.querySelector('p[role="status"]')?.textContent ?? null;
  const back = (app: WorkbenchApp) => { app.shadowRoot?.querySelector("workbench-window-tabs")?.dispatchEvent(new CustomEvent("window-home")); };
  const blankRow = (id: string, cwd = workspace.path): SessionInfo => ({ ...session(id, ""), cwd, path: "", persisted: false, messageCount: 0 });
  const ids = (app: WorkbenchApp) => getState(app).sessions.map((candidate) => candidate.id);
  const isLoading = (app: WorkbenchApp): unknown => Reflect.get(app, "loading");

  it("a held unanchored locate sends no old-machine metadata, status, or project scan after a machine switch", async () => {
    const app = await mountChooser([]);
    setState(app, { ...getState(app), machines: [machine, remote] });
    vi.spyOn(api, "projects").mockResolvedValue([]);
    const located = deferred<{ cwd: string }>();
    vi.spyOn(api, "locate").mockReturnValue(located.promise);
    const sessions = vi.spyOn(api, "sessions").mockResolvedValue([session("old-open", "Old")]);
    const status = vi.spyOn(api, "status").mockResolvedValue(idleStatus("old-open"));
    const workspaces = vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    openFromWorkstream(app, { sessionId: "old-open" });
    await vi.waitFor(() => { expect(api.locate).toHaveBeenCalledWith("old-open", "local"); });
    await call(app, "chooseMachine", remote.id);
    sessions.mockClear(); status.mockClear(); workspaces.mockClear();
    located.resolve({ cwd: workspace.path });
    await flush();
    expect({ sessions: sessions.mock.calls, status: status.mock.calls, workspaces: workspaces.mock.calls }).toEqual({ sessions: [], status: [], workspaces: [] });
    expect(getState(app).selectedSession).toBeUndefined();
    expect(getState(app).selectedMachine?.id).toBe(remote.id);
    expect(getState(app).error).toBe("");
  });

  it("a held anchored workspace listing sends no old-machine row, status, or locate request after a machine switch", async () => {
    const app = await mountChooser([]);
    setState(app, { ...getState(app), machines: [machine, remote] });
    vi.spyOn(api, "projects").mockResolvedValue([]);
    const listed = deferred<Workspace[]>();
    vi.spyOn(api, "workspaces").mockReturnValue(listed.promise);
    const sessions = vi.spyOn(api, "sessions").mockResolvedValue([]);
    const status = vi.spyOn(api, "status").mockResolvedValue(idleStatus("held"));
    const locate = vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    openFromWorkstream(app, { sessionId: "held", projectId: project.id, workspaceId: workspace.id });
    await vi.waitFor(() => { expect(api.workspaces).toHaveBeenCalled(); });
    await call(app, "chooseMachine", remote.id);
    listed.resolve([workspace]);
    await flush();
    expect({ sessions: sessions.mock.calls, status: status.mock.calls.length, locate: locate.mock.calls }).toEqual({ sessions: [], status: 0, locate: [] });
    expect(getState(app).selectedSession).toBeUndefined();
    expect(getState(app).error).toBe("");
  });

  it.each([
    { case: "anchored", detail: { projectId: project.id, workspaceId: workspace.id } },
    { case: "located", detail: {} },
  ])("a held legacy catalog for an $case open never rebuilds the blank Chat from old-machine status after a machine switch", async ({ detail }) => {
    const app = await mountChooser([]);
    setState(app, { ...getState(app), machines: [machine, remote] });
    vi.spyOn(api, "projects").mockResolvedValue([]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const locate = vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    const legacy = deferred<SessionInfo[]>();
    vi.spyOn(api, "sessions").mockReturnValue(legacy.promise);
    const status = vi.spyOn(api, "status").mockResolvedValue(idleStatus("blank"));
    openFromWorkstream(app, { sessionId: "blank", ...detail });
    await vi.waitFor(() => { expect(api.sessions).toHaveBeenCalledWith(workspace.path, "local", { sessionId: "blank" }); });
    await call(app, "chooseMachine", remote.id);
    legacy.resolve([]);
    await flush();
    expect(status).not.toHaveBeenCalled();
    if (detail.projectId !== undefined) expect(locate).not.toHaveBeenCalled();
    expect(getState(app).selectedSession).toBeUndefined();
    expect(getState(app).error).toBe("");
  });

  it("a superseded unanchored open starts no further old-machine project batch", async () => {
    const extra = Array.from({ length: 5 }, (_, index): Project => ({ ...project, id: `p${String(index)}`, name: `P${String(index)}`, path: `/p${String(index)}` }));
    const app = await mountChooser([]);
    setState(app, { ...getState(app), machines: [machine, remote], projects: extra });
    vi.spyOn(api, "projects").mockResolvedValue([]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: "/unregistered" });
    vi.spyOn(api, "sessions").mockResolvedValue([{ ...session("far", "Far"), cwd: "/unregistered" }]);
    const firstBatch = deferred<Workspace[]>();
    const workspaces = vi.spyOn(api, "workspaces").mockReturnValue(firstBatch.promise);
    openFromWorkstream(app, { sessionId: "far" });
    await vi.waitFor(() => { expect(workspaces).toHaveBeenCalledTimes(4); });
    await call(app, "chooseMachine", remote.id);
    firstBatch.resolve([]);
    await flush();
    expect(workspaces).toHaveBeenCalledTimes(4);
    expect(getState(app).selectedSession).toBeUndefined();
  });

  it("drops a held located row-lookup error after a machine switch", async () => {
    const app = await mountChooser([]);
    setState(app, { ...getState(app), machines: [machine, remote] });
    vi.spyOn(api, "projects").mockResolvedValue([]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const row = deferred<SessionInfo[]>();
    vi.spyOn(api, "sessions").mockReturnValue(row.promise);
    openFromWorkstream(app, { sessionId: "err-open" });
    await vi.waitFor(() => { expect(api.sessions).toHaveBeenCalled(); });
    await call(app, "chooseMachine", remote.id);
    row.reject(new HttpRequestError("boom", 500));
    await flush();
    expect(getState(app).error).toBe("");
    expect(getState(app).selectedSession).toBeUndefined();
  });

  it("a fast anchored newer open beats a held older locate, which makes no later lookup", async () => {
    const app = await mountChooser([]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const located = deferred<{ cwd: string }>();
    vi.spyOn(api, "locate").mockReturnValue(located.promise);
    const newer = session("newer", "Newer");
    const sessions = vi.spyOn(api, "sessions").mockImplementation((_cwd, _machineId, options) => Promise.resolve(options?.sessionId === "newer" ? [newer] : [session(options?.sessionId ?? "catalog", "Old")]));
    stubSelectedChat();
    openFromWorkstream(app, { sessionId: "older" });
    await vi.waitFor(() => { expect(api.locate).toHaveBeenCalledWith("older", "local"); });
    openFromWorkstream(app, { sessionId: "newer", projectId: project.id, workspaceId: workspace.id });
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("newer"); });
    located.resolve({ cwd: workspace.path });
    await flush();
    expect(getState(app).selectedSession?.id).toBe("newer");
    expect(sessions.mock.calls.some(([, , options]) => options?.sessionId === "older")).toBe(false);
    expect(getState(app).error).toBe("");
  });

  it("drops an older open's error after a newer open succeeded on the same machine", async () => {
    const app = await mountChooser([]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const located = deferred<{ cwd: string }>();
    vi.spyOn(api, "locate").mockReturnValue(located.promise);
    vi.spyOn(api, "sessions").mockResolvedValue([session("newer", "Newer")]);
    stubSelectedChat();
    openFromWorkstream(app, { sessionId: "older" });
    await vi.waitFor(() => { expect(api.locate).toHaveBeenCalled(); });
    openFromWorkstream(app, { sessionId: "newer", projectId: project.id, workspaceId: workspace.id });
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("newer"); });
    located.reject(new Error("old failed"));
    await flush();
    expect(getState(app).error).toBe("");
    expect(getState(app).selectedSession?.id).toBe("newer");
  });

  it("keeps a current daemon's 404 authoritative at the anchor and the located folder, without status", async () => {
    const app = await mountChooser([]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: "/elsewhere" });
    const sessions = vi.spyOn(api, "sessions").mockRejectedValue(new HttpRequestError("Session not found", 404));
    const status = vi.spyOn(api, "status");
    openFromWorkstream(app, { sessionId: "gone", projectId: project.id, workspaceId: workspace.id });
    await vi.waitFor(() => { expect(getState(app).error).toContain("unavailable"); });
    expect(status).not.toHaveBeenCalled();
    expect(getState(app).selectedSession).toBeUndefined();
    expect(sessions.mock.calls).toEqual([[workspace.path, "local", { sessionId: "gone" }], ["/elsewhere", "local", { sessionId: "gone" }]]);
  });

  it("keeps a current daemon's 404 authoritative for an unanchored open, without status", async () => {
    const app = await mountChooser([]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    vi.spyOn(api, "sessions").mockRejectedValue(new HttpRequestError("Session not found", 404));
    const status = vi.spyOn(api, "status");
    openFromWorkstream(app, { sessionId: "gone" });
    await vi.waitFor(() => { expect(getState(app).error).toContain("unavailable"); });
    expect(status).not.toHaveBeenCalled();
  });

  it.each([
    { case: "its anchor workspace vanished", registered: [], located: workspace.path },
    { case: "its anchor lookup failed", registered: [workspace], located: "/moved" },
  ])("opens the located archived row read-only without status when $case", async ({ registered, located }) => {
    const archived: SessionInfo = { ...session("arch", "Stored"), cwd: located, archived: true, archivedAt: "2026-09-01T00:00:00.000Z" };
    const app = await mountChooser([]);
    vi.spyOn(api, "workspaces").mockResolvedValue(registered);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: located });
    vi.spyOn(api, "sessions").mockImplementation((cwd) => cwd === located ? Promise.resolve([archived]) : Promise.reject(new HttpRequestError("boom", 500)));
    const status = stubSelectedChat();
    openFromWorkstream(app, { sessionId: "arch", projectId: project.id, workspaceId: workspace.id });
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("arch"); });
    await app.updateComplete;
    expect(getState(app).selectedSession?.archived).toBe(true);
    expect(status).not.toHaveBeenCalled();
    expect(promptEditor(app).disabled).toBe(true);
  });

  it("rebuilds a legacy daemon's blank Chat at the anchor from status", async () => {
    const app = await mountChooser([]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const locate = vi.spyOn(api, "locate");
    vi.spyOn(api, "sessions").mockResolvedValue([]);
    const status = stubSelectedChat();
    openFromWorkstream(app, { sessionId: "blank", projectId: project.id, workspaceId: workspace.id });
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("blank"); });
    expect(status).toHaveBeenCalled();
    expect(locate).not.toHaveBeenCalled();
    expect(getState(app).selectedSession?.archived).toBeUndefined();
  });

  it("an open that succeeds during a held chooser catalog clears Loading and Back shows that workspace's catalog", async () => {
    const app = await mountChooser([]);
    const catalog = deferred<SessionInfo[]>();
    const row = session("ws-chat", "Workstream chat");
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const sessions = vi.spyOn(api, "sessions").mockImplementation((_cwd, _machineId, options) => options?.sessionId === undefined ? catalog.promise : Promise.resolve([row]));
    stubSelectedChat();
    void call(app, "chooseWorkspace", workspace.id);
    await vi.waitFor(() => { expect(Reflect.get(app, "loading")).toBe(true); });
    openFromWorkstream(app, { sessionId: row.id, projectId: project.id, workspaceId: workspace.id });
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(row.id); });
    expect(Reflect.get(app, "loading")).toBe(false);
    catalog.resolve([row, session("other", "Other")]);
    await flush();
    back(app);
    await app.updateComplete;
    await flush();
    await app.updateComplete;
    expect({ loading: isLoading(app), text: loadingText(app), sessions: ids(app).sort() }).toEqual({ loading: false, text: null, sessions: ["other", "ws-chat"] });
    // The chooser's own catalog request and the open's catalog behind; no queued stale request after that.
    expect(sessions.mock.calls.filter(([, , options]) => options?.sessionId === undefined)).toHaveLength(2);
  });

  it("a failing open during a held chooser catalog leaves that navigation to finish its list and Loading", async () => {
    const app = await mountChooser([session("existing", "Existing")]);
    const catalog = deferred<SessionInfo[]>();
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "locate").mockRejectedValue(new HttpRequestError("Session x was not found", 404));
    vi.spyOn(api, "sessions").mockImplementation((_cwd, _machineId, options) => options?.sessionId === undefined ? catalog.promise : Promise.reject(new HttpRequestError("Session not found", 404)));
    void call(app, "chooseWorkspace", workspace.id);
    await vi.waitFor(() => { expect(Reflect.get(app, "loading")).toBe(true); });
    openFromWorkstream(app, { sessionId: "missing", projectId: project.id, workspaceId: workspace.id });
    await vi.waitFor(() => { expect(getState(app).error).not.toBe(""); });
    catalog.resolve([session("existing", "Existing")]);
    await flush();
    await app.updateComplete;
    expect({ loading: isLoading(app), text: loadingText(app), sessions: ids(app) }).toEqual({ loading: false, text: null, sessions: ["existing"] });
    expect(getState(app).selectedWorkspace?.id).toBe(workspace.id);
  });

  it("a stale Other-tab card that fails during a machine switch keeps the new machine's projects", async () => {
    const app = await mountChooser([]);
    setState(app, { ...getState(app), machines: [machine, remote] });
    Reflect.set(app, "chooserView", "other");
    await app.updateComplete;
    const remoteProject: Project = { ...project, id: "remote-project", name: "Remote project" };
    const projects = deferred<Project[]>();
    vi.spyOn(api, "projects").mockReturnValue(projects.promise);
    vi.spyOn(api, "locate").mockRejectedValue(new HttpRequestError("not found", 404));
    void call(app, "chooseMachine", remote.id);
    await app.updateComplete;
    openFromWorkstream(app, { sessionId: "stale-card" });
    projects.resolve([remoteProject]);
    await flush();
    await app.updateComplete;
    expect({ projects: getState(app).projects.map((candidate) => candidate.id), loading: isLoading(app) }).toEqual({ projects: ["remote-project"], loading: false });
  });

  it("an open that succeeds during a machine switch still receives that machine's projects", async () => {
    const app = await mountChooser([]);
    setState(app, { ...getState(app), machines: [machine, remote] });
    const remoteProject: Project = { ...project, id: "remote-project", name: "Remote project", path: "/remote" };
    const projects = deferred<Project[]>();
    const listProjects = vi.spyOn(api, "projects").mockReturnValue(projects.promise);
    listProjects.mockClear();
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: "/adhoc" });
    vi.spyOn(api, "sessions").mockResolvedValue([{ ...session("remote-chat", "Remote"), cwd: "/adhoc" }]);
    vi.spyOn(api, "workspaces").mockResolvedValue([]);
    stubSelectedChat();
    void call(app, "chooseMachine", remote.id);
    openFromWorkstream(app, { sessionId: "remote-chat" });
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("remote-chat"); });
    expect(Reflect.get(app, "loading")).toBe(false);
    projects.resolve([remoteProject]);
    await flush();
    expect(getState(app).projects.map((candidate) => candidate.id)).toEqual(["remote-project"]);
    // The machine switch's own request, then one more after the open dropped it.
    expect(listProjects.mock.calls).toEqual([[remote.id], [remote.id]]);
    expect(getState(app).selectedSession?.id).toBe("remote-chat");
  });

  it("reloads a project-less archived URL read-only without status", async () => {
    const archived: SessionInfo = { ...session("arch3", "Stored"), cwd: "/adhoc", archived: true };
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: "/adhoc" });
    vi.spyOn(api, "sessions").mockResolvedValue([archived]);
    const status = stubSelectedChat();
    window.history.replaceState({}, "", "/?session=arch3&view=chat");
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("arch3"); });
    await app.updateComplete;
    expect(getState(app).selectedSession?.archived).toBe(true);
    expect(status).not.toHaveBeenCalled();
    expect(promptEditor(app).disabled).toBe(true);
  });

  it("writes a complete URL for a located registered Chat and a session-only URL for an unregistered one", async () => {
    const app = await mountChooser([]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "locate").mockImplementation((id) => Promise.resolve({ cwd: id === "reg" ? workspace.path : "/adhoc" }));
    vi.spyOn(api, "sessions").mockImplementation((cwd, _machineId, options) => Promise.resolve([{ ...session(options?.sessionId ?? "x", "T"), cwd }]));
    stubSelectedChat();
    openFromWorkstream(app, { sessionId: "reg" });
    await vi.waitFor(() => { expect(window.location.search).toContain("session=reg"); });
    expect(window.location.search).toContain(`project=${project.id}`);
    expect(window.location.search).toContain(`workspace=${workspace.id}`);
    back(app);
    await app.updateComplete;
    openFromWorkstream(app, { sessionId: "unreg" });
    await vi.waitFor(() => { expect(window.location.search).toContain("session=unreg"); });
    expect(window.location.search).not.toContain("project=");
  });

  it("an anchored open keeps an unselected never-saved blank Chat and its draft in the same folder, through the catalog", async () => {
    const blank = blankRow("blank-z");
    saveDraft(machineSessionKey("local", blank.id), "Unsent idea");
    const app = await mountChooser([blank, session("y-old", "Y")]);
    const row = session("y", "Y");
    const catalog = deferred<SessionInfo[]>();
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "sessions").mockImplementation((_cwd, _machineId, options) => options?.sessionId === undefined ? catalog.promise : Promise.resolve([row]));
    stubSelectedChat();
    openFromWorkstream(app, { sessionId: "y", projectId: project.id, workspaceId: workspace.id });
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("y"); });
    expect(ids(app)).toEqual(["blank-z", "y"]);
    catalog.resolve([row, session("other", "Other")]);
    await vi.waitFor(() => { expect(ids(app)).toEqual(["blank-z", "y", "other"]); });
    expect(getState(app).sessions[0]).toEqual(blank);
    expect(loadDraft(machineSessionKey("local", blank.id))).toBe("Unsent idea");
  });

  it("an open in another folder does not carry the previous folder's never-saved Chats", async () => {
    const feature: Workspace = { ...workspace, id: "feature", path: "/repo-feature", label: "feature", isMain: false };
    const app = await mountChooser([blankRow("blank-main"), blankRow("blank-feature", feature.path)]);
    const row: SessionInfo = { ...session("f", "F"), cwd: feature.path };
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace, feature]);
    vi.spyOn(api, "sessions").mockResolvedValue([row]);
    stubSelectedChat();
    openFromWorkstream(app, { sessionId: "f", projectId: project.id, workspaceId: feature.id });
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("f"); });
    await flush();
    expect(ids(app)).toEqual(["blank-feature", "f"]);
  });

  it.each([
    { case: "same machine and folder", machineId: "local", cwd: workspace.path, kept: true },
    { case: "another folder", machineId: "local", cwd: "/elsewhere", kept: false },
    { case: "another machine", machineId: "remote", cwd: workspace.path, kept: false },
  ])("a Chat URL load keeps a never-saved Chat of the $case: $kept", async ({ machineId, cwd, kept }) => {
    const app = await mountChooser([]);
    const owner = machineId === "local" ? machine : remote;
    const blank = blankRow("blank", cwd);
    setState(app, { ...getState(app), machines: [machine, remote], selectedMachine: owner, sessions: [blank, session("stale", "Stale")] });
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const row = session("listed", "Listed");
    const catalog = deferred<SessionInfo[]>();
    vi.spyOn(api, "sessions").mockImplementation((_cwd, _machineId, options) => options?.sessionId === undefined ? catalog.promise : Promise.resolve([row]));
    stubSelectedChat();
    window.history.pushState({}, "", chatUrl(row.id));
    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(row.id); });
    expect(ids(app)).toEqual(kept ? ["blank", "listed"] : ["listed"]);
    catalog.resolve([row]);
    await flush();
    expect(ids(app)).toEqual(kept ? ["blank", "listed"] : ["listed"]);
    expect(Reflect.get(app, "loading")).toBe(false);
  });

  it("UI-015 (accepted caveat): a targeted archived row stays read-only over a fresh unarchived catalog until the workspace is listed again", async () => {
    const archived: SessionInfo = { ...session("ua", "Stored"), archived: true, archivedAt: "2026-09-01T00:00:00.000Z" };
    const app = await mountChooser([]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const catalog = deferred<SessionInfo[]>();
    let full = 0;
    vi.spyOn(api, "sessions").mockImplementation((_cwd, _machineId, options) => {
      if (options?.sessionId !== undefined) return Promise.resolve([archived]);
      full += 1;
      return full === 1 ? catalog.promise : Promise.resolve([session("ua", "Stored")]);
    });
    stubSelectedChat();
    openFromWorkstream(app, { sessionId: "ua", projectId: project.id, workspaceId: workspace.id });
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("ua"); });
    catalog.resolve([session("ua", "Stored")]);
    await flush();
    expect(getState(app).selectedSession?.archived).toBe(true);
    expect(getState(app).sessions.find((candidate) => candidate.id === "ua")?.archived).toBe(true);
    await call(app, "chooseWorkspace", workspace.id);
    expect(getState(app).sessions.find((candidate) => candidate.id === "ua")?.archived).toBeUndefined();
  });
});

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void }

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

function idleStatus(sessionId: string): Awaited<ReturnType<typeof api.status>> {
  return { sessionId, persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
}

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

describe("window tabs", () => {
  const workstreams: Record<string, { id: string; title: string }> = { a1: { id: "release", title: "Release" }, a2: { id: "release", title: "Release" }, b1: { id: "docs", title: "Docs" } };

  async function mountWithWorkstreamChats(): Promise<WorkbenchApp> {
    const rows = [session("a1", "Plan", "Plan the release"), session("a2", "Notes", "Release notes"), session("b1", "Guide", "Install guide")];
    stubWorkstreamService([], ({ operation, input }) => {
      if (operation === "watch") return { ok: true, value: { mode: "replay", events: [], nextSequence: 1 } };
      const sessionId = typeof input["sessionId"] === "string" ? input["sessionId"] : "";
      if (operation === "list") return { ok: true, value: workstreams[sessionId] === undefined ? [] : [{ id: workstreams[sessionId].id }] };
      const owner = Object.values(workstreams).find((candidate) => candidate.id === input["workstreamId"]);
      return { ok: true, value: { id: owner?.id, title: owner?.title, revision: 1, sessions: [], humanTasks: [], links: [], overview: null, closed: false } };
    }, undefined, true);
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "sessions").mockImplementation((_cwd, _machineId, options) => Promise.resolve(rows.filter((row) => options?.sessionId === undefined || row.id === options.sessionId)));
    stubSelectedChat();
    window.history.replaceState({}, "", "/?win=w1&project=project&workspace=workspace&session=a1&view=chat");
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(async () => { await app.updateComplete; expect(chatTabs(app)).toEqual(["Plan the release"]); });
    for (const title of ["Release notes", "Install guide"]) {
      tabsRoot(app).querySelector<HTMLButtonElement>("button.add")?.click();
      await vi.waitFor(() => { expect(sessionTitles(app)).toContain(title); });
      [...(app.shadowRoot?.querySelectorAll<HTMLButtonElement>(".session") ?? [])].find((button) => button.textContent.includes(title))?.click();
      await vi.waitFor(() => { expect(chatTabs(app)).toContain(title); });
    }
    await vi.waitFor(async () => { await app.updateComplete; expect(workstreamTabs(app)).toEqual(["Release2", "Docs"]); });
    return app;
  }

  it("opens each Chat as a tab under its Workstream, and a Workstream tab reopens its last-active Chat", async () => {
    const app = await mountWithWorkstreamChats();
    expect(getState(app).selectedSession?.id).toBe("b1");

    workstreamTab(app, "Release").click();
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
    await app.updateComplete;
    expect(chatTabs(app)).toEqual(["Plan the release", "Release notes"]);
    expect(window.location.search).toContain("win=w1");
    expect(window.location.search).toContain("session=a2");

    workstreamTab(app, "Docs").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("b1"); });
    workstreamTab(app, "Release").dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
  });

  it("counts each Chat's open questions on its tab, live from this window and from status another window caused", async () => {
    const app = await mountWithWorkstreamChats();
    workstreamTab(app, "Release").click();
    await vi.waitFor(() => { expect(chatTabs(app)).toEqual(["Plan the release", "Release notes"]); });
    const selected = getState(app).selectedSession?.id;
    const other = selected === "a1" ? "a2" : "a1";
    const ask = (askId: string, questions: number) => ({ askId, askedAt: "2026-10-19T10:00:00.000Z", updatedAt: "2026-10-19T10:00:00.000Z", revision: "r1", turnsSinceUpdate: 0, questions: Array.from({ length: questions }, (_, index) => ({ id: `q${String(index)}`, question: `Question ${String(index)}?`, options: [] })) });
    const count = (sessionId: string) => tabsRoot(app).querySelector(`.chat-tab[data-session="${sessionId}"] .questions`)?.textContent ?? null;
    const receive = (event: unknown) => { Reflect.apply(Reflect.get(app, "handleRealtimeEvent") as (event: unknown) => void, app, [event]); }; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- private handler

    receive({ type: "status.update", status: { ...idleStatus(other), pendingAsks: [ask("abc-1", 2), ask("def-2", 1)] } });
    await vi.waitFor(async () => { await app.updateComplete; expect(count(other)).toBe("3"); });
    expect(count(selected ?? "")).toBeNull();

    // The selected Chat's own stream keeps its live asks, as an ask.opened frame does.
    setState(app, { ...getState(app), pendingAsks: [ask("ghi-3", 1)] });
    await vi.waitFor(async () => { await app.updateComplete; expect(count(selected ?? "")).toBe("1"); });

    receive({ type: "status.update", status: { ...idleStatus(other), pendingAsks: [ask("def-2", 1)] } });
    await vi.waitFor(async () => { await app.updateComplete; expect(count(other)).toBe("1"); });
    receive({ type: "status.update", status: idleStatus(other) });
    await vi.waitFor(async () => { await app.updateComplete; expect(count(other)).toBeNull(); });
  });

  it("asks once for each restored Chat's status as the window connects, so an idle Chat's tab counts its questions after a reload", async () => {
    await mountWithWorkstreamChats();
    document.body.replaceChildren();
    await vi.waitFor(async () => { expect((await locks.query()).held?.map((lock) => lock.name)).not.toContain(`${WINDOW_ID_LOCK_PREFIX}w1`); });
    const ask = { askId: "abc-1", askedAt: "2026-10-19T10:00:00.000Z", updatedAt: "2026-10-19T10:00:00.000Z", revision: "r1", turnsSinceUpdate: 0, questions: [{ id: "a", question: "A?", options: [] }, { id: "b", question: "B?", options: [] }] };
    const status = vi.spyOn(api, "status").mockImplementation((ref) => Promise.resolve(ref.id === "a1" ? { ...idleStatus("a1"), pendingAsks: [ask] } : idleStatus(ref.id)));
    const sockets: SilentWebSocket[] = [];
    vi.stubGlobal("WebSocket", class extends SilentWebSocket { constructor(url: string) { super(); if (url.endsWith("/api/machines/local/events")) sockets.push(this); } });
    window.history.replaceState({}, "", "/?win=w1&project=project&workspace=workspace&session=a2&view=chat");
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); expect(sockets.length).toBeGreaterThan(0); });
    const count = (sessionId: string) => tabsRoot(app).querySelector(`.chat-tab[data-session="${sessionId}"] .questions`)?.textContent ?? null;
    expect(count("a1")).toBeNull();
    status.mockClear();

    // Opened twice before the first answers: each other Chat is asked once; the Chat on screen not at all.
    const realtime = sockets.at(-1);
    realtime?.onopen?.();
    realtime?.onopen?.();
    await vi.waitFor(async () => { await app.updateComplete; expect(count("a1")).toBe("2"); });
    expect(status.mock.calls.map(([ref]) => ref.id).sort()).toEqual(["a1", "b1"]);
  });

  it("puts the Chat's tools in the tab row, naming its folder in the Files tooltip, and gives them back to the tile in a grid", async () => {
    const app = await mountWithWorkstreamChats();
    const tools = () => app.shadowRoot?.querySelector('workbench-window-tabs > .chat-tools[slot="tools"]');

    expect(app.shadowRoot?.querySelector(".chat-shell > header")).toBeNull();
    expect(tools()?.querySelector(".files-toggle")?.getAttribute("title")).toBe("Files \u2014 Project \u00b7 main (/repo)");
    await vi.waitFor(() => { expect(drawerTitle(app)).toBe("Docs"); });
    expect(tools()?.querySelector("workstream-context-drawer")).not.toBeNull();
    expect(workstreamTabs(app)).toEqual(["Release2", "Docs"]);

    closeButton(app, "Install guide").click();
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
    await app.updateComplete;
    expect(workstreamTabs(app)).toEqual([]);
    expect(chatTabs(app)).toEqual(["Plan the release", "Release notes"]);

    const toggleLayout = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true, cancelable: true }));
    toggleLayout();
    await settled(app);
    expect(tools()).toBeNull();
    expect(app.shadowRoot?.querySelector('.tile[data-focused="true"] .chat-shell > header .files-toggle')).not.toBeNull();
    toggleLayout();
    await settled(app);
    expect(tools()).not.toBeNull();

    tabsRoot(app).querySelector<HTMLButtonElement>("button.add")?.click();
    await vi.waitFor(() => { expect(app.shadowRoot?.querySelector('[data-view="chooser"]')).not.toBeNull(); });
    expect(tools()).toBeNull();
  });

  it("closing the Chat on screen shows the next tab, and closing the last one shows the home", async () => {
    const app = await mountWithWorkstreamChats();

    closeButton(app, "Install guide").click();
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
    await app.updateComplete;
    expect(chatTabs(app)).toEqual(["Plan the release", "Release notes"]);
    closeButton(app, "Plan the release").click();
    await app.updateComplete;
    expect(getState(app).selectedSession?.id).toBe("a2");
    closeButton(app, "Release notes").click();
    await vi.waitFor(() => { expect(app.shadowRoot?.querySelector('[data-view="chooser"]')).not.toBeNull(); });
    expect(tabsRoot(app).querySelector("nav")).toBeNull();
  });

  it("switches to a grid with \u2303G, keeps only the visible tiles live, and hands a pressed tile to the shell", async () => {
    // happy-dom loses a removed shadow root's focus; focusing the composer is not what this test checks.
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const app = await mountWithWorkstreamChats();
    const press = (key: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }));

    press("g");
    await settled(app);
    const tiles = () => [...(app.shadowRoot?.querySelectorAll<HTMLElement>(".grid > .tile") ?? [])];
    expect(tiles()).toHaveLength(3);
    expect(tiles().filter((tile) => tile.dataset["focused"] === "true").map((tile) => tile.querySelector(".chat-shell")?.getAttribute("data-session"))).toEqual(["b1"]);
    expect(paneChats(app)).toEqual(["a1", "a2"]);
    expect(tabsRoot(app).querySelector(".workstream-tab")).toBeNull();

    app.shadowRoot?.querySelector('.tile[data-session="a1"]')?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a1"); });
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector('.tile[data-focused="true"] .chat-shell')?.getAttribute("data-session")).toBe("a1");
    expect(paneChats(app)).toEqual(["a2", "b1"]);

    app.shadowRoot?.querySelector<HTMLButtonElement>('.tile[data-focused="true"] header button[aria-label="Full size"]')?.click();
    await settled(app);
    expect(tiles()).toHaveLength(1);
    expect(app.shadowRoot?.querySelectorAll("workbench-chat-pane")).toHaveLength(0);
    expect(app.shadowRoot?.querySelector<HTMLButtonElement>('header button[aria-label="Restore grid"]')).not.toBeNull();

    press("g");
    await settled(app);
    expect(tiles()).toHaveLength(1);
    expect(workstreamTabs(app)).toEqual(["Release2", "Docs"]);
    expect(app.shadowRoot?.querySelector('header button[aria-label="Full size"]')).toBeNull();
  });

  it("puts a grid tile's own open questions as chips above its compact composer", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const app = await mountWithWorkstreamChats();
    const ask = { askId: "abc-1", askedAt: "2026-10-19T10:00:00.000Z", updatedAt: "2026-10-19T10:00:00.000Z", revision: "r1", turnsSinceUpdate: 0, questions: [{ id: "db", question: "Which database?", options: [] }] };
    vi.spyOn(api, "status").mockImplementation((ref) => Promise.resolve(ref.id === "a2" ? { ...idleStatus("a2"), pendingAsks: [ask] } : idleStatus(ref.id)));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true, cancelable: true }));
    await settled(app);
    const tile = (sessionId: string) => app.shadowRoot?.querySelector('.tile[data-session="' + sessionId + '"] workbench-chat-pane')?.shadowRoot;

    await vi.waitFor(() => { expect(tile("a2")?.querySelector<WorkbenchQuestionChips>("workbench-question-chips")?.asks).toEqual([ask]); });
    expect(tile("a2")?.querySelector("workbench-question-chips")?.nextElementSibling?.localName).toBe("prompt-editor");
    expect(tile("a1")?.querySelector<WorkbenchQuestionChips>("workbench-question-chips")?.asks).toEqual([]);
  });

  it("opens a side tile's question in one press: the tile takes the shell and the drawer opens at that question", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const app = await mountWithWorkstreamChats();
    const ask = { askId: "abc-1", askedAt: "2026-10-19T10:00:00.000Z", updatedAt: "2026-10-19T10:00:00.000Z", revision: "r1", turnsSinceUpdate: 0, questions: [{ id: "db", question: "Which database?", options: [] }, { id: "why", question: "Why now?", options: [] }] };
    vi.spyOn(api, "status").mockImplementation((ref) => Promise.resolve(ref.id === "a2" ? { ...idleStatus("a2"), pendingAsks: [ask] } : idleStatus(ref.id)));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true, cancelable: true }));
    await settled(app);
    const sideChips = () => app.shadowRoot?.querySelector('.tile[data-session="a2"] workbench-chat-pane')?.shadowRoot?.querySelector<WorkbenchQuestionChips>("workbench-question-chips");
    await vi.waitFor(async () => { await sideChips()?.updateComplete; expect(sideChips()?.shadowRoot?.querySelectorAll(".chip")).toHaveLength(2); });

    sideChips()?.shadowRoot?.querySelectorAll(".chip")[1]?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));

    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
    const shellChips = () => app.shadowRoot?.querySelector<WorkbenchQuestionChips>('.tile[data-focused="true"] .chat-column > workbench-question-chips');
    await vi.waitFor(async () => { await shellChips()?.updateComplete; expect(shellChips()?.shadowRoot?.querySelector('.drawer ask-user-card[data-ask="abc-1"]')).not.toBeNull(); });
  });

  it("keeps the Chat on screen and its Files pane mounted across \u2303G and full size", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const app = await mountWithWorkstreamChats();
    app.shadowRoot?.querySelector<HTMLButtonElement>(".files-toggle")?.click();
    await app.updateComplete;
    const pane = app.shadowRoot?.querySelector("workbench-files-pane");
    const composer = app.shadowRoot?.querySelector("prompt-editor");
    expect(pane).not.toBeNull();
    const press = async (key: string) => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }));
      await settled(app);
      expect(app.shadowRoot?.querySelector("workbench-files-pane")).toBe(pane);
      expect(app.shadowRoot?.querySelector("prompt-editor")).toBe(composer);
    };

    await press("g");
    const panes = [...(app.shadowRoot?.querySelectorAll("workbench-chat-pane") ?? [])];
    expect(panes).toHaveLength(2);
    // Removing a tile mid-load leaks its composer's editor in happy-dom.
    await vi.waitFor(() => { expect(panes.every((tile) => tile.shadowRoot?.querySelector("prompt-editor") !== null)).toBe(true); });
    await press("Enter");
    expect(app.shadowRoot?.querySelectorAll("workbench-chat-pane")).toHaveLength(0);
    await press("g");
  });

  it("loads a tile's Chat from its own machine, not the focused Chat's", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const remote: Machine = { ...machine, id: "remote", name: "Remote", kind: "remote" };
    vi.spyOn(api, "machines").mockResolvedValue([machine, remote]);
    await mountWithWorkstreamChats();
    const stored = parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY));
    const w1 = stored["w1"];
    if (w1 === undefined) throw new Error("missing window");
    localStorage.setItem(WINDOW_STORE_KEY, JSON.stringify({ ...stored, w1: { ...w1, chats: w1.chats.map((chat) => chat.sessionId === "a1" ? { ...chat, machineId: "remote" } : chat) } }));
    window.dispatchEvent(new StorageEvent("storage", { key: WINDOW_STORE_KEY }));
    const snapshot = vi.mocked(api.transcriptSnapshot);
    snapshot.mockClear();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true, cancelable: true }));

    await vi.waitFor(() => { expect(snapshot.mock.calls.find(([selected]) => selected.id === "a1")?.[2]).toBe("remote"); });
    expect(snapshot.mock.calls.find(([selected]) => selected.id === "a2")?.[2]).toBe("local");
  });

  it("moves a Chat to a new window from its tab's menu, and this window shows its next tab", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const app = await mountWithWorkstreamChats();

    tabsRoot(app).querySelector('.chat-tab[data-session="b1"]')?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, clientX: 30, clientY: 40 }));
    await app.updateComplete;
    const menu = app.shadowRoot?.querySelector<HTMLElement>('.window-menu[aria-label="Install guide"]');
    expect([...(menu?.querySelectorAll("button") ?? [])].map((item) => item.textContent.trim())).toEqual(["Move to new window", "Close"]);
    menu?.querySelector<HTMLButtonElement>("button")?.click();

    const url = new URL(String(opened.mock.calls[0]?.[0]));
    const target = url.searchParams.get("win") ?? "";
    expect(url.pathname).toBe("/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ win: target, project: "project", workspace: "workspace", session: "b1", view: "chat" });
    await vi.waitFor(() => { expect(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY))[target]).toMatchObject({ name: "Window 2", focused: "b1" }); });
    const stored = parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY));
    expect(stored[target]?.chats.map((chat) => chat.workstream?.title)).toEqual(["Docs"]);
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector(".window-menu")).toBeNull();
    expect(chatTabs(app)).toEqual(["Plan the release", "Release notes"]);

    // One Workstream left, so no Workstream row: its menu comes from the tab component's own event.
    app.shadowRoot?.querySelector("workbench-window-tabs")?.dispatchEvent(new CustomEvent("chat-tab-menu", { detail: { sessionIds: ["a1", "a2"], label: "Release", clientX: 0, clientY: 0 } }));
    await app.updateComplete;
    const items = [...(app.shadowRoot?.querySelectorAll<HTMLButtonElement>(".window-menu button") ?? [])];
    expect(items.map((item) => item.textContent.trim())).toEqual(["Move to new window", "Move to Window 2 (closed)", "Close 2 Chats"]);
    items[1]?.click();
    await vi.waitFor(() => { expect(app.shadowRoot?.querySelector('[data-view="chooser"]')).not.toBeNull(); });
    expect(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY))[target]?.chats.map((chat) => chat.sessionId)).toEqual(["b1", "a1", "a2"]);
  });

  it("keeps the Chat and opens no window when moving it would discard unsaved file edits", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const app = await mountWithWorkstreamChats();
    app.shadowRoot?.querySelector<HTMLButtonElement>(".files-toggle")?.click();
    await app.updateComplete;
    const pane = app.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane");
    if (pane === null || pane === undefined) throw new Error("Files pane was not mounted");
    const canClose = vi.spyOn(pane, "canClose").mockReturnValue(false);

    tabsRoot(app).querySelector('.chat-tab[data-session="b1"]')?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true }));
    await app.updateComplete;
    app.shadowRoot?.querySelector<HTMLButtonElement>(".window-menu button")?.click();
    await app.updateComplete;

    expect(opened).not.toHaveBeenCalled();
    expect(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY))["w1"]?.chats.map((chat) => chat.sessionId)).toContain("b1");
    expect(getState(app).selectedSession?.id).toBe("b1");

    canClose.mockClear().mockReturnValue(true);
    tabsRoot(app).querySelector('.chat-tab[data-session="b1"]')?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true }));
    await app.updateComplete;
    app.shadowRoot?.querySelector<HTMLButtonElement>(".window-menu button")?.click();
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(canClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a Chat with staged attachments in this window and says why", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const app = await mountWithWorkstreamChats();
    const moveToNewWindow = async (tab: Element | null) => {
      tab?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true }));
      await app.updateComplete;
      app.shadowRoot?.querySelector<HTMLButtonElement>(".window-menu button")?.click();
      await app.updateComplete;
    };
    saveStagedAttachments(machineSessionKey("local", "a1"), { attachments: [{ id: "att-1", kind: "file", name: "notes.txt", mimeType: "text/plain", data: "aGk=", size: 2 }], nextImageReference: 1, pendingImageReferences: [], generation: 0 });
    await moveToNewWindow(workstreamTab(app, "Release"));

    expect(opened).not.toHaveBeenCalled();
    expect(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY))["w1"]?.chats.map((chat) => chat.sessionId).sort()).toEqual(["a1", "a2", "b1"]);
    expect(app.shadowRoot?.querySelector(".chat-error")?.textContent).toContain("Plan the release");
    clearStagedAttachments(machineSessionKey("local", "a1"));
  });

  it("takes Chats dropped from another window once that window hands them over, and none while it keeps them", async () => {
    const app = await mountWithWorkstreamChats();
    const moved = { sessionId: "c1", title: "Elsewhere", machineId: "local", projectId: "project", workspaceId: "workspace" };
    localStorage.setItem(WINDOW_STORE_KEY, JSON.stringify(openChat(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY)), "w9", moved)));
    vi.spyOn(api, "sessions").mockResolvedValue([session("c1", "Else", "Elsewhere")]);
    let handOver = false;
    const asked: unknown[] = [];
    const source = otherWindow("w9", (request, from) => {
      asked.push(request);
      if (handOver && request.kind === "move") localStorage.setItem(WINDOW_STORE_KEY, JSON.stringify(moveChats(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY)), "w9", from, request.sessionIds)));
      return handOver;
    });
    const drop = () => tabsRoot(app).querySelector("nav")?.dispatchEvent(new CustomEvent("chat-tab-drop", { bubbles: true, composed: true, detail: { windowId: "w9", sessionIds: ["c1"] } }));
    try {
      drop();
      await vi.waitFor(() => { expect(asked).toEqual([{ kind: "move", sessionIds: ["c1"] }]); });
      await settled(app);
      expect(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY))["w9"]?.chats.map((chat) => chat.sessionId)).toEqual(["c1"]);
      expect(getState(app).selectedSession?.id).toBe("b1");

      handOver = true;
      drop();
      await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("c1"); });
      const after = parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY));
      expect(after["w9"]?.chats).toEqual([]);
      expect(after["w1"]?.focused).toBe("c1");
    } finally {
      source.close();
    }
  });

  it("hands Chats dropped in another window over only once its owner gives up unsaved file edits", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const app = await mountWithWorkstreamChats();
    app.shadowRoot?.querySelector<HTMLButtonElement>(".files-toggle")?.click();
    await app.updateComplete;
    const pane = app.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane");
    if (pane === null || pane === undefined) throw new Error("Files pane was not mounted");
    const canClose = vi.spyOn(pane, "canClose").mockReturnValue(false);
    const target = otherWindow("w9", () => false);
    try {
      target.ask("w1", { kind: "move", sessionIds: ["b1"] });
      await vi.waitFor(() => { expect(target.answers).toEqual([false]); });
      expect(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY))["w1"]?.chats.map((chat) => chat.sessionId)).toContain("b1");
      expect(getState(app).selectedSession?.id).toBe("b1");

      canClose.mockReturnValue(true);
      target.ask("w1", { kind: "move", sessionIds: ["b1"] });
      await vi.waitFor(() => { expect(target.answers).toEqual([false, true]); });
      const stored = parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY));
      expect(stored["w9"]?.chats.map((chat) => chat.sessionId)).toEqual(["b1"]);
      expect(stored["w1"]?.chats.map((chat) => chat.sessionId)).not.toContain("b1");
      await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
    } finally {
      target.close();
    }
  });

  it("routes a notification for a Chat another live window holds to that window once it answers, and that window keeps it", async () => {
    const app = await mountWithWorkstreamChats();
    const elsewhere = { sessionId: "c1", title: "Elsewhere", machineId: "local", projectId: "project", workspaceId: "workspace" };
    localStorage.setItem(WINDOW_STORE_KEY, JSON.stringify(openChat(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY)), "w2", elsewhere)));
    const release = locks.hold(`${WINDOW_ID_LOCK_PREFIX}w2`);
    const received: unknown[] = [];
    // The holder reloads as the first request arrives, and answers the next.
    const owner = otherWindow("w2", (request) => { received.push(request); return received.length > 1 ? true : new Promise<boolean>(() => undefined); });
    try {
      window.dispatchEvent(new CustomEvent(NATIVE_NOTIFICATION_OPEN_EVENT, { detail: { machineId: "local", sessionId: "c1", message: "entry:e1" } }));

      await vi.waitFor(() => { expect(received).toHaveLength(2); }, { timeout: 2_000 });
      expect(received[0]).toEqual({ kind: "select", sessionId: "c1", anchor: "entry:e1" });
      await settled(app);
      const stored = parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY));
      expect(stored["w2"]?.chats.map((chat) => chat.sessionId)).toEqual(["c1"]);
      expect(stored["w1"]?.chats.map((chat) => chat.sessionId)).not.toContain("c1");
      expect(getState(app).selectedSession?.id).toBe("b1");
      expect(app.shadowRoot?.querySelector(".chat-error")).toBeNull();

      owner.ask("w1", { kind: "select", sessionId: "a2" });
      await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
      await vi.waitFor(() => { expect(owner.answers).toEqual([true]); });
    } finally {
      owner.close();
      release();
    }
  });

  it("tells the macOS app which Chats this window holds, so a notification goes to their window and none other changes", async () => {
    const app = await mountWithWorkstreamChats();
    const elsewhere = { sessionId: "c1", title: "Elsewhere", machineId: "local", projectId: "project", workspaceId: "workspace" };
    localStorage.setItem(WINDOW_STORE_KEY, JSON.stringify(openChat(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY)), "w2", elsewhere)));
    const holds = (machineId: string, sessionId: string) => !window.dispatchEvent(new CustomEvent(NATIVE_NOTIFICATION_HOLDS_EVENT, { cancelable: true, detail: { machineId, sessionId } }));
    const before = localStorage.getItem(WINDOW_STORE_KEY);

    expect(holds("local", "a2")).toBe(true);
    expect(holds("local", "c1")).toBe(false);
    expect(holds("remote", "a2")).toBe(false);
    expect(holds("local", "unknown")).toBe(false);
    await settled(app);
    expect(localStorage.getItem(WINDOW_STORE_KEY)).toBe(before);
    expect(getState(app).selectedSession?.id).toBe("b1");

    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    window.dispatchEvent(new CustomEvent(NATIVE_NOTIFICATION_OPEN_EVENT, { detail: { machineId: "local", sessionId: "a2" } }));
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
    expect(new URLSearchParams(window.location.search).get("win")).toBe("w1");
    expect(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY))["w2"]?.chats.map((chat) => chat.sessionId)).toEqual(["c1"]);
  });

  it("shows a Chat another live window holds there when Back or the chooser opens it, and stays as it is", async () => {
    const app = await mountWithWorkstreamChats();
    const elsewhere = { sessionId: "c1", title: "Elsewhere", machineId: "local", projectId: "project", workspaceId: "workspace" };
    localStorage.setItem(WINDOW_STORE_KEY, JSON.stringify(openChat(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY)), "w2", elsewhere)));
    const release = locks.hold(`${WINDOW_ID_LOCK_PREFIX}w2`);
    const received: unknown[] = [];
    const owner = otherWindow("w2", (request) => { received.push(request); return true; });
    const held = () => parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY));
    try {
      window.history.pushState({}, "", "/?win=w1&project=project&workspace=workspace&session=c1&view=chat");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await vi.waitFor(() => { expect(received).toEqual([{ kind: "select", sessionId: "c1" }]); });
      await settled(app);
      expect(getState(app).selectedSession?.id).toBe("b1");
      expect(new URLSearchParams(window.location.search).get("session")).toBe("b1");

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", metaKey: true, bubbles: true, cancelable: true }));
      await vi.waitFor(() => { expect(app.shadowRoot?.querySelector("workstream-chooser")).not.toBeNull(); });
      openFromWorkstream(app, { sessionId: "c1", projectId: "project", workspaceId: "workspace" });
      await vi.waitFor(() => { expect(received).toHaveLength(2); });
      await settled(app);
      expect(getState(app).selectedSession).toBeUndefined();
      expect(held()["w2"]?.chats.map((chat) => chat.sessionId)).toEqual(["c1"]);
      expect(held()["w1"]?.chats.map((chat) => chat.sessionId)).not.toContain("c1");
    } finally {
      owner.close();
      release();
    }
  });

  it("without Web Locks keeps this window's Chats to itself and offers no moves", async () => {
    Reflect.deleteProperty(navigator, "locks");
    try {
      const app = await mountWithWorkstreamChats();
      expect(localStorage.getItem(WINDOW_STORE_KEY)).toBeNull();
      expect(parseWindowStore(sessionStorage.getItem(WINDOW_STORE_KEY))["w1"]?.chats).toHaveLength(3);

      tabsRoot(app).querySelector('.chat-tab[data-session="b1"]')?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true }));
      await app.updateComplete;
      expect([...(app.shadowRoot?.querySelectorAll(".window-menu button") ?? [])].map((item) => item.textContent.trim())).toEqual(["Close"]);
    } finally {
      sessionStorage.clear();
    }
  });

  it("follows another window that takes the Chat on screen, retiring it before the next Chat loads", async () => {
    const app = await mountWithWorkstreamChats();
    const successor = holdLookup("a2");
    const stored = parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY));
    localStorage.setItem(WINDOW_STORE_KEY, JSON.stringify(openChat(stored, "w2", { sessionId: "b1", title: "Install guide", machineId: "local" })));
    window.dispatchEvent(new StorageEvent("storage", { key: WINDOW_STORE_KEY }));

    await settled(app);
    expect(getState(app).selectedSession).toBeUndefined();
    expect(app.shadowRoot?.querySelector("prompt-editor")).toBeNull();
    successor.release();
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
    await app.updateComplete;
    expect(workstreamTabs(app)).toEqual([]);
    expect(chatTabs(app)).toHaveLength(2);
  });

  it("drops a delayed open of a Chat another live window opened meanwhile, and shows it there", async () => {
    const app = await mountWithWorkstreamChats();
    const lookup = holdLookup("c1");
    const release = locks.hold(`${WINDOW_ID_LOCK_PREFIX}w2`);
    const received: unknown[] = [];
    const owner = otherWindow("w2", (request) => { received.push(request); return true; });
    try {
      window.history.pushState({}, "", "/?win=w1&project=project&workspace=workspace&session=c1&view=chat");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await vi.waitFor(() => { expect(lookup.asked()).toBe(true); });
      const elsewhere = { sessionId: "c1", title: "Elsewhere", machineId: "local", projectId: "project", workspaceId: "workspace" };
      localStorage.setItem(WINDOW_STORE_KEY, JSON.stringify(openChat(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY)), "w2", elsewhere)));
      lookup.release();

      await vi.waitFor(() => { expect(received).toEqual([{ kind: "select", sessionId: "c1" }]); });
      await settled(app);
      const stored = parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY));
      expect(stored["w2"]?.chats.map((chat) => chat.sessionId)).toEqual(["c1"]);
      expect(stored["w1"]?.chats.map((chat) => chat.sessionId)).not.toContain("c1");
      expect(getState(app).selectedSession?.id).not.toBe("c1");
    } finally {
      owner.close();
      release();
    }
  });

  it("drops a delayed tab activation of a Chat moved to another window meanwhile", async () => {
    const app = await mountWithWorkstreamChats();
    const lookup = holdLookup("a2");
    const target = otherWindow("w2", () => false);
    try {
      app.shadowRoot?.querySelector("workbench-window-tabs")?.dispatchEvent(new CustomEvent("chat-tab-select", { detail: { sessionId: "a2" } }));
      await vi.waitFor(() => { expect(lookup.asked()).toBe(true); });
      target.ask("w1", { kind: "move", sessionIds: ["a2"] });
      await vi.waitFor(() => { expect(target.answers).toEqual([true]); });
      lookup.release();

      await settled(app);
      await settled(app);
      const stored = parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY));
      expect(stored["w2"]?.chats.map((chat) => chat.sessionId)).toEqual(["a2"]);
      expect(stored["w1"]?.chats.map((chat) => chat.sessionId)).not.toContain("a2");
      expect(getState(app).selectedSession?.id).toBe("b1");
    } finally {
      target.close();
    }
  });

  it("retires the moved Chat's composer before the store hands the Chat on, while its successor still loads", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const app = await mountWithWorkstreamChats();
    const successor = holdLookup("a2");
    const writable: (string | undefined)[] = [];
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (key === WINDOW_STORE_KEY && parseWindowStore(value)["w1"]?.chats.some((chat) => chat.sessionId === "b1") === false) {
        writable.push(app.shadowRoot?.querySelector<PromptEditor>("prompt-editor")?.sessionId);
      }
      setItem(key, value);
    });

    tabsRoot(app).querySelector('.chat-tab[data-session="b1"]')?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true }));
    await app.updateComplete;
    app.shadowRoot?.querySelector<HTMLButtonElement>(".window-menu button")?.click();
    await vi.waitFor(() => { expect(writable).not.toEqual([]); });
    await settled(app);

    expect(writable.every((sessionId) => sessionId === undefined)).toBe(true);
    expect(app.shadowRoot?.querySelector("prompt-editor")).toBeNull();
    successor.release();
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
  });

  it("keeps Chats whose hand-over the asking window gave up on while their owner decided", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const app = await mountWithWorkstreamChats();
    app.shadowRoot?.querySelector<HTMLButtonElement>(".files-toggle")?.click();
    await app.updateComplete;
    const pane = app.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane");
    if (pane === null || pane === undefined) throw new Error("Files pane was not mounted");
    const now = Date.now();
    // The owner confirms discarding file edits only after the asking window stopped waiting.
    vi.spyOn(pane, "canClose").mockImplementation(() => { vi.spyOn(Date, "now").mockReturnValue(now + 61_000); return true; });
    const target = otherWindow("w9", () => false);
    try {
      target.ask("w1", { kind: "move", sessionIds: ["b1"] });
      await vi.waitFor(() => { expect(target.answers).toEqual([false]); });
      expect(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY))["w1"]?.chats.map((chat) => chat.sessionId)).toContain("b1");
      expect(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY))["w9"]).toBeUndefined();
      await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("b1"); });
    } finally {
      target.close();
    }
  });

  it("keeps the workspace and Files of the Chat on screen when a delayed tab in another workspace was moved away", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const app = await mountWithWorkstreamChats();
    const original = getState(app).selectedWorkspace;
    const otherWorkspace = { ...workspace, id: "other-workspace", path: "/other-repository" };
    const lookup = deferred<SessionInfo[]>();
    let asked = false;
    const listed = vi.mocked(api.sessions).getMockImplementation();
    vi.mocked(api.sessions).mockImplementation((cwd, machineId, options) => {
      if (options?.sessionId === "a2") { asked = true; return lookup.promise; }
      return listed?.(cwd, machineId, options) ?? Promise.resolve([]);
    });
    vi.mocked(api.workspaces).mockResolvedValue([workspace, otherWorkspace]);
    const saved = parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY));
    const own = saved["w1"];
    if (own !== undefined) saved["w1"] = { ...own, chats: own.chats.map((chat) => chat.sessionId === "a2" ? { ...chat, workspaceId: otherWorkspace.id } : chat) };
    localStorage.setItem(WINDOW_STORE_KEY, JSON.stringify(saved));
    window.dispatchEvent(new StorageEvent("storage", { key: WINDOW_STORE_KEY }));
    app.shadowRoot?.querySelector("workbench-window-tabs")?.dispatchEvent(new CustomEvent("chat-tab-select", { detail: { sessionId: "a2" } }));
    await vi.waitFor(() => { expect(asked).toBe(true); });
    const target = otherWindow("w2", () => true);
    const release = locks.hold(`${WINDOW_ID_LOCK_PREFIX}w2`);
    try {
      target.ask("w1", { kind: "move", sessionIds: ["a2"] });
      await vi.waitFor(() => { expect(target.answers).toEqual([true]); });
      lookup.resolve([{ ...session("a2", "Notes"), cwd: otherWorkspace.path }]);
      await settled(app);
      await settled(app);

      expect(getState(app).selectedSession?.id).toBe("b1");
      expect(getState(app).selectedWorkspace?.path).toBe(original?.path);
      app.shadowRoot?.querySelector<HTMLButtonElement>(".files-toggle")?.click();
      await app.updateComplete;
      expect(app.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane")?.workspace?.path).toBe(original?.path);
    } finally {
      target.close();
      release();
    }
  });

  it("lets New Chat in the chooser a close exposed win over the closed Chat's delayed successor", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const app = await mountWithWorkstreamChats();
    const successor = holdLookup("a2");
    const created = deferred<SessionInfo>();
    vi.spyOn(api, "startSession").mockReturnValue(created.promise);
    closeButton(app, "Install guide").click();
    await vi.waitFor(() => { expect(successor.asked()).toBe(true); });
    app.shadowRoot?.querySelector<HTMLButtonElement>(".new-chat button")?.click();
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id.startsWith("creating:")).toBe(true); });
    successor.release();
    await settled(app);
    await settled(app);
    created.resolve({ ...session("new-chat", "Fresh"), persisted: false });
    await settled(app);
    await settled(app);

    expect(getState(app).selectedSession?.id).toBe("new-chat");
    expect(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY))["w1"]?.chats.map((chat) => chat.sessionId)).toContain("new-chat");
  });

  it("does not let a selection queued behind the window store overwrite a later New Chat", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const app = await mountWithWorkstreamChats();
    const release = locks.hold("pi-workbench.windows.store");
    const started = deferred<SessionInfo>();
    vi.spyOn(api, "startSession").mockReturnValue(started.promise);
    const sessions: unknown = Reflect.get(app, "sessions");
    if (!(sessions instanceof SessionController)) throw new Error("Session controller missing");
    const selecting = sessions.selectSession(session("c1", "Claimed"));
    const creating = sessions.startSession();
    // New Chat must reserve its identity before publishing a writable composer.
    expect(getState(app).selectedSession?.id).toBe("b1");
    release();
    await selecting;
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id.startsWith("creating:")).toBe(true); });
    started.resolve({ ...session("new-chat", "Fresh"), persisted: false });
    await creating;
    await settled(app);
    expect(getState(app).selectedSession?.id).toBe("new-chat");
  });

  it("shows a created Chat only in the window holding it when another window claimed its id before the creation answered", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const source = await mountWithWorkstreamChats();
    const created = deferred<SessionInfo>();
    const row = { ...session("new-chat", "Fresh"), persisted: false };
    vi.spyOn(api, "startSession").mockReturnValue(created.promise);
    tabsRoot(source).querySelector<HTMLButtonElement>("button.add")?.click();
    await source.updateComplete;
    source.shadowRoot?.querySelector<HTMLButtonElement>(".new-chat button")?.click();
    await vi.waitFor(() => { expect(getState(source).selectedSession?.id.startsWith("creating:")).toBe(true); });
    vi.mocked(api.sessions).mockResolvedValue([row]);
    // The daemon exposes the created id to another live window before the creator's HTTP response returns.
    window.history.replaceState({}, "", "/?win=w2&project=project&workspace=workspace&session=new-chat&view=chat");
    const target = new WorkbenchApp();
    document.body.append(target);
    await vi.waitFor(() => { expect(getState(target).selectedSession?.id).toBe("new-chat"); });
    await settled(target);
    window.dispatchEvent(new StorageEvent("storage", { key: WINDOW_STORE_KEY }));
    await settled(source);
    expect(getState(source).selectedSession?.id.startsWith("creating:")).toBe(true);
    // Store writes reach the other window at once, as storage events do between real windows.
    const windows: unknown = Reflect.get(source, "windows");
    const environment: unknown = typeof windows === "object" && windows !== null ? Reflect.get(windows, "environment") : undefined;
    if (typeof environment !== "object" || environment === null) throw new Error("Window environment missing");
    Reflect.set(environment, "storage", {
      getItem: localStorage.getItem.bind(localStorage),
      setItem: (key: string, value: string) => {
        localStorage.setItem(key, value);
        if (key === WINDOW_STORE_KEY) queueMicrotask(() => window.dispatchEvent(new StorageEvent("storage", { key })));
      },
    });
    created.resolve(row);
    await settled(source);
    await settled(target);
    await settled(source);
    await settled(target);

    expect(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY))["w2"]?.chats.map((chat) => chat.sessionId)).toContain("new-chat");
    const writable = [source, target].map((app) => app.shadowRoot?.querySelector<PromptEditor>("prompt-editor")).filter((editor) => editor?.sessionId === "new-chat" && !editor.disabled);
    expect(writable).toHaveLength(1);
  });

  it("keeps a legacy daemon's unreserved first prompt separate instead of overwriting a new owner's draft", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const source = await mountWithWorkstreamChats();
    const created = deferred<SessionInfo>();
    const row = { ...session("new-chat", ""), persisted: false, messageCount: 0 };
    vi.spyOn(api, "startSession").mockReturnValue(created.promise);
    const sessions: unknown = Reflect.get(source, "sessions");
    if (!(sessions instanceof SessionController)) throw new Error("Session controller missing");
    const creating = sessions.startSession();
    await settled(source);
    const tempId = getState(source).selectedSession?.id ?? "";
    promptEditor(source).replaceText("important first prompt");
    vi.mocked(api.sessions).mockResolvedValue([row, session("another", "Another")]);
    window.history.replaceState({}, "", "/?win=w2&project=project&workspace=workspace&session=another&view=chat");
    const target = new WorkbenchApp();
    document.body.append(target);
    await vi.waitFor(() => { expect(getState(target).selectedSession?.id).toBe("another"); });
    await settled(target);
    tabsRoot(target).querySelector<HTMLButtonElement>("button.add")?.click();
    await settled(target);
    [...(target.shadowRoot?.querySelectorAll<HTMLButtonElement>(".session") ?? [])].find((button) => !button.textContent.includes("Another"))?.click();
    await vi.waitFor(() => { expect(getState(target).selectedSession?.id).toBe("new-chat"); });
    await settled(target);
    await promptEditor(target).updateComplete;
    promptEditor(target).replaceText("new owner's draft");
    created.resolve(row);
    await creating;
    await settled(source);
    await settled(target);
    expect(loadDraft(machineSessionKey("local", tempId))).toBe("important first prompt");
    expect(loadDraft(machineSessionKey("local", "new-chat"))).toBe("new owner's draft");

    target.shadowRoot?.querySelector("workbench-window-tabs")?.dispatchEvent(new CustomEvent("chat-tab-select", { detail: { sessionId: "another" } }));
    await vi.waitFor(() => { expect(getState(target).selectedSession?.id).toBe("another"); });
    await settled(target);
    expect(loadDraft(machineSessionKey("local", tempId))).toBe("important first prompt");
    expect(loadDraft(machineSessionKey("local", "new-chat"))).toBe("new owner's draft");
  });

  it.each(["home", "history", "notification", "slow-tab", "remote"])("r5: %s during creation keeps its draft and sends to its original Chat", async (mode) => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    vi.mocked(api.machines).mockResolvedValue([machine, { ...machine, id: "remote", name: "Remote", kind: "remote" }]);
    const app = await mountWithWorkstreamChats();
    const created = deferred<SessionInfo>();
    vi.spyOn(api, "startSession").mockReturnValue(created.promise);
    const sent = vi.spyOn(api, "prompt").mockResolvedValue({ accepted: true });
    const sessions = sessionsOf(app);
    const creating = sessions.startSession();
    await settled(app);
    promptEditor(app).replaceText("draft before navigation");
    await sessions.send("queued first message");
    const slow = mode === "slow-tab" ? holdLookup("a2") : undefined;
    if (mode === "home") tabsRoot(app).querySelector<HTMLButtonElement>("button.add")?.click();
    else if (mode === "slow-tab") app.shadowRoot?.querySelector("workbench-window-tabs")?.dispatchEvent(new CustomEvent("chat-tab-select", { detail: { sessionId: "a2" } }));
    else if (mode === "history") {
      window.history.replaceState({}, "", "/?win=w1&project=project&workspace=workspace&session=a2&view=chat");
      window.dispatchEvent(new PopStateEvent("popstate"));
    } else {
      vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
      window.dispatchEvent(new CustomEvent(NATIVE_NOTIFICATION_OPEN_EVENT, { detail: { machineId: mode === "remote" ? "remote" : "local", sessionId: "a2" } }));
    }
    if (slow !== undefined) await vi.waitFor(() => { expect(slow.asked()).toBe(true); });
    else if (mode !== "home") await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
    await settled(app);
    const row = { ...session("created-after-navigation", ""), persisted: false, messageCount: 0 };
    created.resolve(row);
    await creating;
    await settled(app);
    expect(sent.mock.calls.map(([target, text, , machineId]) => [target.id, text, machineId])).toEqual([[row.id, "queued first message", "local"]]);
    expect(loadDraft(machineSessionKey("local", row.id))).toBe("draft before navigation");
    expect(getState(app).selectedSession?.id).toBe(mode === "home" || mode === "slow-tab" ? undefined : "a2");
    slow?.release();
    if (slow !== undefined) await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
    expect(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY))["w1"]?.chats.find((chat) => chat.sessionId === row.id)?.machineId).toBe("local");
  });

  it("keeps edits and sends made while creation completion waits for the store lock", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const app = await mountWithWorkstreamChats();
    const created = deferred<SessionInfo>();
    vi.spyOn(api, "startSession").mockReturnValue(created.promise);
    const sent = vi.spyOn(api, "prompt").mockResolvedValue({ accepted: true });
    const sessions = sessionsOf(app);
    const creating = sessions.startSession();
    await settled(app);
    await sessions.send("before response");
    const release = locks.hold("pi-workbench.windows.store");
    created.resolve({ ...session("created-after-lock", ""), persisted: false });
    await settled(app);
    promptEditor(app).replaceText("edited while completion waited");
    await sessions.send("during completion");
    release();
    await creating;
    await settled(app);
    expect(sent.mock.calls.map(([, text]) => text)).toEqual(["before response", "during completion"]);
    expect(promptEditor(app).view?.state.doc.toString()).toBe("edited while completion waited");
  });

  it("r5: same-Chat reload completion cannot cancel a newer slow tab navigation", async () => {
    const app = await mountWithWorkstreamChats();
    const reloaded = deferred<Awaited<ReturnType<typeof api.reloadSession>>>();
    vi.spyOn(api, "reloadSession").mockReturnValue(reloaded.promise);
    const sessions = sessionsOf(app);
    const reloading = sessions.reloadSession();
    const next = holdLookup("a2");
    app.shadowRoot?.querySelector("workbench-window-tabs")?.dispatchEvent(new CustomEvent("chat-tab-select", { detail: { sessionId: "a2" } }));
    await vi.waitFor(() => { expect(next.asked()).toBe(true); });
    const generation = sessions.navigationGeneration;
    reloaded.resolve({ reloaded: true });
    await reloading;
    expect(sessions.navigationGeneration).toBe(generation);
    next.release();
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("a2"); });
  });

  it.each([false, true])("r5–r8: reserves the creator's draft before any startup event (missed=%s)", async (missed) => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const source = await mountWithWorkstreamChats();
    const created = deferred<SessionInfo>();
    const start = vi.spyOn(api, "startSession").mockReturnValue(created.promise);
    const sessions = sessionsOf(source);
    const creating = sessions.startSession();
    await settled(source);
    const tempId = getState(source).selectedSession?.id ?? "";
    const row = { ...session("reserved-chat", ""), persisted: false, messageCount: 0, startupToken: start.mock.calls[0]?.[2] ?? "" };
    promptEditor(source).replaceText("important first prompt");
    if (!missed) sessions.applyGlobalEvent({ type: "session.startup", startupToken: row.startupToken, activity: { sessionId: row.id, phase: "active", label: "Creating session", at: "now", startup: true } });
    vi.mocked(api.sessions).mockResolvedValue([row, session("another", "Another")]);
    window.history.replaceState({}, "", "/?win=w2&project=project&workspace=workspace&session=another&view=chat");
    const target = new WorkbenchApp();
    document.body.append(target);
    await vi.waitFor(() => { expect(getState(target).selectedSession?.id).toBe("another"); });
    const targetSessions = sessionsOf(target);
    await targetSessions.selectSession(row);
    await settled(target);
    expect(getState(target).selectedSession?.id).toBe("another");
    expect(getState(source).selectedSession?.id).toBe(tempId);
    created.resolve(row);
    await creating;
    await settled(source);
    expect(promptEditor(source).view?.state.doc.toString()).toBe("important first prompt");
    expect(loadDraft(machineSessionKey("local", row.id))).toBe("important first prompt");
    await sessions.selectSession(session("a2", "Notes"));
    await sessions.selectSession(row);
    await settled(source);
    expect(promptEditor(source).view?.state.doc.toString()).toBe("important first prompt");
  });

  it.each([false, true])("r8: Add and reselect returns to the same pending draft (ad-hoc=%s)", async (adHoc) => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const app = await mountWithWorkstreamChats();
    if (adHoc) setState(app, { ...getState(app), selectedProject: undefined, selectedWorkspace: adHocWorkspace(workspace.path) });
    const created = deferred<SessionInfo>();
    const start = vi.spyOn(api, "startSession").mockReturnValue(created.promise);
    const sessions = sessionsOf(app);
    const creating = sessions.startSession();
    await settled(app);
    const tempId = getState(app).selectedSession?.id ?? "";
    const row = { ...session("reserved-chat", ""), persisted: false, startupToken: start.mock.calls[0]?.[2] ?? "" };
    promptEditor(app).replaceText("first prompt");
    sessions.applyGlobalEvent({ type: "session.startup", startupToken: row.startupToken, activity: { sessionId: row.id, phase: "active", label: "Creating session", at: "now", startup: true } });
    await settled(app);
    tabsRoot(app).querySelector<HTMLButtonElement>("button.add")?.click();
    await settled(app);
    // A pending tab and a chooser/notification row carrying the real id are the same Chat.
    app.shadowRoot?.querySelector("workbench-window-tabs")?.dispatchEvent(new CustomEvent("chat-tab-select", { detail: { sessionId: tempId } }));
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(tempId); });
    await sessions.selectSession(row);
    await settled(app);
    expect(getState(app).selectedSession?.id).toBe(tempId);
    expect(promptEditor(app).view?.state.doc.toString()).toBe("first prompt");
    promptEditor(app).replaceText("first prompt and edits");
    created.resolve(row);
    await creating;
    await settled(app);
    expect(promptEditor(app).view?.state.doc.toString()).toBe("first prompt and edits");
  });

  it("r8: a pending tab cannot move or close its reservation before creation settles", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const app = await mountWithWorkstreamChats();
    const created = deferred<SessionInfo>();
    vi.spyOn(api, "startSession").mockReturnValue(created.promise);
    const sessions = sessionsOf(app);
    const creating = sessions.startSession();
    await settled(app);
    const tempId = getState(app).selectedSession?.id ?? "";
    promptEditor(app).replaceText("first prompt");
    sessions.applyGlobalEvent({ type: "session.startup", startupToken: tempId, activity: { sessionId: "reserved-chat", phase: "active", label: "Creating session", at: "now", startup: true } });
    await settled(app);
    const tabs = tabsRoot(app);
    const tab = tabs.querySelector(`[data-session="reserved-chat"]`) ?? tabs.querySelector(`[data-session="${tempId}"]`);
    expect(tab).not.toBeNull();
    tab?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true }));
    await app.updateComplete;
    [...(app.shadowRoot?.querySelectorAll<HTMLButtonElement>(".window-menu button") ?? [])].find((button) => button.textContent === "Move to new window")?.click();
    await settled(app);
    expect(opened).not.toHaveBeenCalled();
    expect(promptEditor(app).view?.state.doc.toString()).toBe("first prompt");
    created.resolve({ ...session("reserved-chat", ""), persisted: false });
    await creating;
  });

  it("sends a second window opening a Chat still being created to the window creating it, which keeps its composer", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    const source = await mountWithWorkstreamChats();
    const created = deferred<SessionInfo>();
    const row = { ...session("new-chat", ""), persisted: false, messageCount: 0 };
    vi.spyOn(api, "startSession").mockReturnValue(created.promise);
    const sessions: unknown = Reflect.get(source, "sessions");
    if (!(sessions instanceof SessionController)) throw new Error("Session controller missing");
    const creating = sessions.startSession();
    await settled(source);
    promptEditor(source).replaceText("first prompt");
    const startupToken = getState(source).selectedSession?.id ?? "";
    sessions.applyGlobalEvent({ type: "session.startup", startupToken, activity: { sessionId: "new-chat", phase: "active", label: "Creating session", at: "now", startup: true } });
    expect(parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY))["w1"]?.chats.map((chat) => chat.sessionId)).toContain(startupToken);
    vi.mocked(api.sessions).mockResolvedValue([{ ...row, startupToken }]);
    window.history.replaceState({}, "", "/?win=w2&project=project&workspace=workspace&session=new-chat&view=chat");
    const target = new WorkbenchApp();
    document.body.append(target);
    await vi.waitFor(() => { expect(target.shadowRoot?.querySelector('[data-view="chooser"]')).not.toBeNull(); });
    await settled(target);
    expect(getState(target).selectedSession).toBeUndefined();
    expect(target.shadowRoot?.querySelector("prompt-editor")).toBeNull();
    expect(getState(source).selectedSession?.id).toBe(startupToken);

    created.resolve(row);
    await creating;
    await settled(source);
    expect(getState(source).selectedSession?.id).toBe("new-chat");
    expect(promptEditor(source).view?.state.doc.toString()).toBe("first prompt");
    const store = parseWindowStore(localStorage.getItem(WINDOW_STORE_KEY));
    expect(store["w1"]?.chats.map((chat) => chat.sessionId)).toContain("new-chat");
    expect(store["w2"]?.chats.map((chat) => chat.sessionId) ?? []).not.toContain("new-chat");
  });

  it("brings a Chat whose move storage refused back with the composer text storage could not save", async () => {
    vi.spyOn(PromptEditor.prototype, "focusInput").mockImplementation(() => undefined);
    vi.spyOn(window, "open").mockReturnValue(null);
    const app = await mountWithWorkstreamChats();
    await settled(app);
    promptEditor(app).replaceText("saved draft");
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    promptEditor(app).replaceText("saved draft plus unsaved edits");
    tabsRoot(app).querySelector('.chat-tab[data-session="b1"]')?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true }));
    await app.updateComplete;
    [...(app.shadowRoot?.querySelectorAll<HTMLButtonElement>(".window-menu button") ?? [])].find((item) => item.textContent.trim() === "Move to new window")?.click();
    await vi.waitFor(() => {
      expect(getState(app).selectedSession?.id).toBe("b1");
      expect(getState(app).error).toContain("storage is full");
      expect(promptEditor(app).view?.state.doc.toString()).toBe("saved draft plus unsaved edits");
    });
    // Another window's heartbeat leaves the text alone, though storage still holds the older draft.
    window.dispatchEvent(new StorageEvent("storage", { key: "pi-workbench.windows.alive.v1" }));
    expect(promptEditor(app).view?.state.doc.toString()).toBe("saved draft plus unsaved edits");
  });

  it("tries a title change full storage refused once, not again on its own error", async () => {
    const app = await mountWithWorkstreamChats();
    await settled(app);
    const sessions: unknown = Reflect.get(app, "sessions");
    if (!(sessions instanceof SessionController)) throw new Error("Session controller missing");
    const store = localStorage.setItem.bind(localStorage);
    let attempts = 0;
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key !== WINDOW_STORE_KEY) { store(key, value); return; }
      attempts += 1;
      throw new DOMException("full", "QuotaExceededError");
    });
    sessions.applyGlobalEvent({ type: "session.name", sessionId: "b1", name: "A longer auto-generated Chat title" });
    await vi.waitFor(() => { expect(getState(app).error).toContain("storage is full"); });
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(attempts).toBe(1);
  });
});

function sessionsOf(app: WorkbenchApp): SessionController {
  const sessions: unknown = Reflect.get(app, "sessions");
  if (!(sessions instanceof SessionController)) throw new Error("Session controller missing");
  return sessions;
}

/** Holds the targeted row lookup of `sessionId` until released; other lookups answer at once. */
function holdLookup(sessionId: string) {
  const held = deferred<undefined>();
  let asked = false;
  const listed = vi.mocked(api.sessions).getMockImplementation();
  vi.mocked(api.sessions).mockImplementation(async (cwd, machineId, options) => {
    if (options?.sessionId === sessionId) { asked = true; await held.promise; return [session(sessionId, sessionId)]; }
    return listed === undefined ? [] : await listed(cwd, machineId, options);
  });
  return { asked: () => asked, release: () => { held.resolve(undefined); } };
}

type OtherWindowRequest = { kind: "select"; sessionId: string; anchor?: string } | { kind: "move"; sessionIds: string[] };

function isOtherWindowMessage(message: unknown): message is { id: string; to: string; from: string; request?: OtherWindowRequest; ok?: boolean } {
  return typeof message === "object" && message !== null && typeof Reflect.get(message, "to") === "string" && typeof Reflect.get(message, "from") === "string";
}

/** Another window on the shared channel: answers requests sent to `windowId`, and asks windows itself. */
function otherWindow(windowId: string, answer: (request: OtherWindowRequest, from: string) => boolean | Promise<boolean>) {
  const channel = new BroadcastChannel(WINDOW_CHANNEL);
  const answers: boolean[] = [];
  let asked = 0;
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isOtherWindowMessage(message) || message.to !== windowId) return;
    const request = message.request;
    if (request === undefined) { answers.push(message.ok === true); return; }
    void Promise.resolve(answer(request, message.from)).then((ok) => { channel.postMessage({ id: message.id, to: message.from, from: windowId, ok }); });
  };
  return {
    answers,
    ask: (to: string, request: OtherWindowRequest, timeoutMs = 60_000) => { asked += 1; channel.postMessage({ id: `${windowId}:${String(asked)}`, to, from: windowId, request, expires: Date.now() + timeoutMs }); },
    close: () => { channel.close(); },
  };
}

/** A window store write settles before the render it causes. */
async function settled(app: WorkbenchApp): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await app.updateComplete;
}

function tabsRoot(app: WorkbenchApp): ShadowRoot {
  const root = app.shadowRoot?.querySelector("workbench-window-tabs")?.shadowRoot;
  if (root === null || root === undefined) throw new Error("Window tabs were not rendered");
  return root;
}

const paneChats = (app: WorkbenchApp): (string | undefined)[] => [...(app.shadowRoot?.querySelectorAll("workbench-chat-pane") ?? [])].map((pane) => pane instanceof WorkbenchChatPane ? pane.chat?.sessionId : undefined);
const workstreamTabs = (app: WorkbenchApp): string[] => [...tabsRoot(app).querySelectorAll(".workstream-tab")].map((tab) => tab.textContent.replace(/\s+/gu, ""));
const chatTabs = (app: WorkbenchApp): string[] => [...tabsRoot(app).querySelectorAll(".chat-tab .title")].map((title) => title.textContent);

function workstreamTab(app: WorkbenchApp, title: string): HTMLElement {
  const tab = [...tabsRoot(app).querySelectorAll<HTMLElement>(".workstream-tab")].find((candidate) => candidate.querySelector(".title")?.textContent === title);
  if (tab === undefined) throw new Error(`No Workstream tab ${title}`);
  return tab;
}

function closeButton(app: WorkbenchApp, title: string): HTMLButtonElement {
  const button = tabsRoot(app).querySelector<HTMLButtonElement>(`button[aria-label="Close ${title}"]`);
  if (button === null) throw new Error(`No close button for ${title}`);
  return button;
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
    expect(drawerTitle(app)).toBeUndefined();

    associated = true;
    revision = 1;
    await vi.waitFor(() => { expect(drawerTitle(app)).toBe("External Workstream"); }, { timeout: 3_000 });

    title = "Renamed elsewhere";
    revision = 2;
    await vi.waitFor(() => { expect(drawerTitle(app)).toBe("Renamed elsewhere"); }, { timeout: 3_000 });

    associated = false;
    revision = 3;
    await vi.waitFor(() => { expect(drawerTitle(app)).toBeUndefined(); }, { timeout: 3_000 });
    const watchCalls = calls.filter((call) => call.operation === "watch");
    expect(watchCalls.length).toBeGreaterThanOrEqual(4);
    expect(watchCalls[0]?.input).toEqual({ afterSequence: Number.MAX_SAFE_INTEGER });
    expect(getState(app).selectedSession?.id).toBe("current");
  }, 10_000);

  it("keeps the Chat tools in the header, the Workstream drawer only with a Workstream, and status controls beside the composer", async () => {
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
    expect(shell.querySelector("header > .files-toggle")).not.toBeNull();
    expect(shell.querySelector("header > workstream-context-drawer")).toBeNull();
    Reflect.set(app, "currentWorkstream", { id: "ws", title: "Release", revision: 1, sessions: [], humanTasks: [], links: [], overview: null, closed: false });
    await app.updateComplete;
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
    expect(goal.nextElementSibling?.tagName).toBe("WORKBENCH-QUESTION-CHIPS");
    expect(goal.nextElementSibling?.nextElementSibling?.tagName).toBe("PROMPT-EDITOR");
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
