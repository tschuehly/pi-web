// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Machine, type Project, type SessionInfo, type Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { DEFAULT_INTERFACE_SCALE, INTERFACE_SCALE_STORAGE_KEY, readStoredInterfaceScale } from "../interfaceScale";
import { machineSessionKey } from "../machineKeys";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { PromptEditor } from "./PromptEditor";
import { WorkbenchApp, rootProjectOf, rootProjects } from "./WorkbenchApp";

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
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, value: [] }), { status: 200 }))));
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
  it("starts a Chat in a picked folder without a project and reopens it from the session id alone", async () => {
    vi.spyOn(api, "projects").mockResolvedValue([]);
    const started = session("adhoc", "");
    started.cwd = "/anywhere/notes";
    vi.spyOn(api, "startSession").mockResolvedValue(started);
    vi.spyOn(api, "sessions").mockResolvedValue([]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: "/anywhere/notes" });
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: "adhoc", persisted: false, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    window.piWebNative = { pickDirectory: () => Promise.resolve("/anywhere/notes") };

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
      detail: { workstreamId: "workstream", sessionId: "continued", directories: [], prompt: "Continue" },
    }));

    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("continued"); });
    expect(getState(app).selectedWorkspace?.id).toBe(workspace.id);
    expect(sessions).not.toHaveBeenCalled();
  });

  it("records and confirms a Workstream launch around Chat creation, then preloads the durable prompt draft", async () => {
    const started = session("new-session", "");
    const protocol: string[] = [];
    const calls: WorkstreamServiceCall[] = [];
    let inspectCount = 0;
    stubWorkstreamService(calls, (body) => {
      if (body.operation === "inspect") return { ok: true, value: { id: "workstream", revision: inspectCount++ === 0 ? 70 : 71, sessions: [], humanTasks: [] } };
      protocol.push("append");
      return { ok: true, value: { acceptedRevision: typeof body.input["expectedRevision"] === "number" ? body.input["expectedRevision"] + 1 : 0 } };
    }, protocol);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    const startSession = vi.spyOn(api, "startSession").mockImplementation(() => { protocol.push("start"); return Promise.resolve(started); });
    const locate = vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const prompt = vi.spyOn(api, "prompt").mockResolvedValue({ accepted: true });
    const app = await mountChooser([]);

    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("start-workstream-session", {
      detail: { workstreamId: "workstream", sessionId: "previous", directories: [], prompt: "Carry on" },
    }));

    await vi.waitFor(() => { expect(calls.filter((call) => call.operation === "append")).toHaveLength(2); });
    const [pending, confirmed] = calls.filter((call) => call.operation === "append").map((call) => call.input);
    expect(protocol).toEqual(["inspect", "append", "start", "inspect", "append"]);
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
    await vi.waitFor(() => { expect(loadDraft(machineSessionKey("local", "new-session"))).toBe("Carry on"); });
    expect(app.shadowRoot?.activeElement?.tagName).toBe("PROMPT-EDITOR");
    expect(locate).toHaveBeenCalledWith("previous", "local");
    expect(getState(app).selectedWorkspace?.id).toBe(workspace.id);
  });

  it("does not preload a successful Workstream launch into a different selected Chat", async () => {
    const started = session("new-session", "");
    const other = session("other-session", "Other");
    const calls: WorkstreamServiceCall[] = [];
    stubWorkstreamService(calls, (body) => body.operation === "inspect"
      ? { ok: true, value: { id: "workstream", revision: 4, sessions: [], humanTasks: [] } }
      : { ok: true, value: { acceptedRevision: 5 } });
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "startSession").mockResolvedValue(started);
    let resolveStatus: ((value: Awaited<ReturnType<typeof api.status>>) => void) | undefined;
    vi.spyOn(api, "status").mockImplementation(() => new Promise((resolve) => { resolveStatus = resolve; }));
    const otherDraftKey = machineSessionKey("local", other.id);
    saveDraft(otherDraftKey, "Keep this draft");
    const app = await mountChooser([other]);

    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("start-workstream-session", {
      detail: { workstreamId: "workstream", sessionId: "previous", directories: [], prompt: "Carry on" },
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

  it("does not preload an ambiguous failed launch into a different selected Chat", async () => {
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
      detail: { workstreamId: "workstream", sessionId: "previous", directories: [], prompt: "Carry on" },
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
      detail: { workstreamId: "workstream", sessionId: "previous", directories: [], prompt: "Carry on" },
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

function stubWorkstreamService(calls: WorkstreamServiceCall[], respond: (body: WorkstreamServiceCall) => unknown, protocol?: string[]): void {
  vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
    if (typeof init?.body !== "string") return Promise.resolve(new Response(JSON.stringify({ ok: true, value: [] }), { status: 200 }));
    const body = JSON.parse(init.body) as WorkstreamServiceCall; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- decoded test request
    if (body.operation === "list") return Promise.resolve(new Response(JSON.stringify({ ok: true, value: [] }), { status: 200 }));
    calls.push(body);
    if (body.operation === "inspect") protocol?.push("inspect");
    return Promise.resolve(new Response(JSON.stringify(respond(body)), { status: 200 }));
  }));
}

describe("Workbench interface scale shortcuts", () => {
  it("steps the stored scale up, down, and back to the default on Cmd/Ctrl +/-/0", async () => {
    const app = await mountChooser([]);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", metaKey: true, cancelable: true }));
    expect(readStoredInterfaceScale()).toBe(1.1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "-", ctrlKey: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "-", ctrlKey: true, cancelable: true }));
    expect(readStoredInterfaceScale()).toBe(0.9);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", metaKey: true, cancelable: true }));
    expect(readStoredInterfaceScale()).toBe(DEFAULT_INTERFACE_SCALE);
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

describe("Workbench Chat controls", () => {
  it("mounts the delegate roster and Working Mode controls beside the composer", async () => {
    const current = session("current", "Build the UI");
    const app = await mountChooser([current]);
    setState(app, { ...getState(app), selectedSession: current });
    await app.updateComplete;

    const shell = app.shadowRoot?.querySelector(".chat-shell");
    if (shell === null || shell === undefined) throw new Error("Chat shell was not rendered");
    expect(shell.querySelector("header > workstream-context-drawer")).not.toBeNull();
    expect(shell.querySelector("header > strong")).toBeNull();
    expect(shell.querySelector("delegate-roster")).not.toBeNull();
    expect(shell.querySelector("working-mode-controls")).toBeNull();
    const promptEditor = shell.querySelector<PromptEditor>("prompt-editor");
    if (promptEditor === null) throw new Error("Prompt editor was not rendered");
    await promptEditor.updateComplete;
    const controls = promptEditor.shadowRoot?.querySelector("working-mode-controls");
    expect(controls).not.toBeNull();
    expect(controls?.nextElementSibling?.classList.contains("send-button")).toBe(true);
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

function setState(app: WorkbenchApp, state: AppState): void {
  if (!Reflect.set(app, "app", state)) throw new Error("Could not set WorkbenchApp state");
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
