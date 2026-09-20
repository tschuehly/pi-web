// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Machine, type Project, type SessionInfo, type Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { WorkbenchApp, rootProjectOf, rootProjects } from "./WorkbenchApp";

beforeEach(() => {
  vi.spyOn(api, "machines").mockResolvedValue([machine]);
  vi.spyOn(api, "projects").mockResolvedValue([]);
  vi.stubGlobal("WebSocket", SilentWebSocket);
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  document.body.replaceChildren();
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

describe("Workbench Chat chooser", () => {
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
