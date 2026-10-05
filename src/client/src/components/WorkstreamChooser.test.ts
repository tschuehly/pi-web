// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkstreamChooser, WorkstreamServiceError, actor, appendWorkstream, attentionOf, directoriesOf, firstClause, groupMatchesProject, isTemporaryDirectory, latestCheckpoints, referencesOf, sessionsByActivity, watchWorkstreams, type OpenWorkstreamSessionDetail, type WorkstreamSnapshot } from "./WorkstreamChooser";
import { workstreamAccentColor } from "../workstreamColor";
import { pluginsApi, sessionsApi, workspacesApi } from "../api/clients";
import { HttpRequestError } from "../api/http";
import type { SessionInfo, Workspace } from "../api";

// Legacy checkpoints still carry a continuation prompt; PI WEB must neither show nor preload it.
const checkpoint = (id: string, recordedAt: string, next: string, references: string[] = []) => ({ id, whatChanged: `${id} changed. More detail.`, remains: "Review", next, nextSessionPrompt: `Continue ${id}`, references, recordedAt });

const snapshot: WorkstreamSnapshot = {
  id: "ws-1", title: "Improve OpenAPI source learning", revision: 70, updatedAt: "2026-09-18T10:31:02.522Z", closed: false,
  sessions: [
    { id: "s-old", status: "active", latestCheckpoint: checkpoint("cp-old", "2026-09-10T08:00:00.000Z", "Pia does old thing") },
    { id: "s-a", status: "active", latestCheckpoint: checkpoint("cp-a", "2026-09-18T07:29:54.464Z", "Thomas reviews the stack", ["/repo/me", "/repo/me/plan.md"]) },
    { id: "s-b", status: "active", projectId: "p1", workspaceId: "w1", latestCheckpoint: checkpoint("cp-b", "2026-09-18T10:31:02.522Z", "Thomas logs in and asks the five questions.", ["/repo/me-trial"]) },
    { id: "s-none", status: "active", latestCheckpoint: null },
  ],
  humanTasks: [
    { id: "t1", title: "Merge order?", status: "pending", answerKind: null, options: [], sourceSessionId: null },
    { id: "t2", title: "Done", status: "resolved", answerKind: null, options: [], sourceSessionId: null },
  ],
  links: [],
  overview: { goal: "Teach Me the PhotoQuest API.", doneWhen: "Five questions answered.", description: "Why and scope.", history: ["2026-09-08: slice 1 merged.", "PR #1283 ready."], recordedAt: "2026-09-20T09:00:00.000Z" },
};

const summaries = [{ id: "ws-2", title: "Older", group: null, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", lastCheckpointAt: "2026-09-01T00:00:00.000Z", unresolvedHumanTaskCount: 0, next: "Pia does old thing", waitingOn: "agent" as const }, { id: "ws-1", title: snapshot.title, group: "Embabel", createdAt: "2026-08-28T00:00:00.000Z", updatedAt: snapshot.updatedAt, lastCheckpointAt: new Date().toISOString(), unresolvedHumanTaskCount: 1, next: "Thomas logs in and asks the five questions.", waitingOn: "owner" as const }];

// PI WEB session metadata: s-b is anchored in workspace w1 of project p1, s-a is located through its working directory, s-old and s-none are unknown.
const chat = (id: string, name: string | undefined, modified: string, cwd = "/repo/me"): SessionInfo => ({ id, path: `/sessions/${id}.jsonl`, cwd, ...(name === undefined ? {} : { name }), created: modified, modified, messageCount: 3, firstMessage: "" });
const workspace = (id: string, projectId: string, path: string): Workspace => ({ id, projectId, path, label: id, isMain: true, effectiveConfig: {} });
const catalog = [chat("s-b", "Trial login", "2026-09-18T10:40:00.000Z", "/repo/me-trial"), chat("s-a", "Stack review", "2026-09-18T07:30:00.000Z")];
function chatsResponse(url: string): Response | undefined {
  if (url.includes("/sessions/recent")) return Response.json([catalog[0]]);
  if (url.includes("/sessions/locate/s-a")) return Response.json({ cwd: "/repo/me" });
  if (url.includes("/sessions/locate/")) return new Response("not found", { status: 404 });
  const query = /\/sessions\?(.*)$/.exec(url)?.[1];
  if (query === undefined) return undefined;
  const params = new URLSearchParams(query);
  const row = catalog.find((candidate) => candidate.id === params.get("sessionId") && candidate.cwd === params.get("cwd"));
  return row === undefined ? new Response("not found", { status: 404 }) : Response.json([row]);
}

/** A promise the test settles explicitly, to hold one lookup while others finish. */
function held<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const notFound = () => Promise.reject(new HttpRequestError("Session not found", 404));
const titleOf = (element: WorkstreamChooser, sessionId: string): string | undefined => shadow(element).querySelector(`[data-session-id="${sessionId}"] .session-title`)?.textContent;
const targetedCalls = (sessionId: string) => vi.mocked(sessionsApi.sessions).mock.calls.filter(([, , options]) => options?.sessionId === sessionId);

async function openCard(element: WorkstreamChooser, workstreamId = "ws-1"): Promise<void> {
  await vi.waitFor(() => { expect(shadow(element).querySelector(".row")).not.toBeNull(); });
  const row = [...shadow(element).querySelectorAll<HTMLElement>(".workstream")].find((item) => item.style.getPropertyValue("--workstream-color") === workstreamAccentColor(workstreamId));
  row?.querySelector<HTMLButtonElement>(".row")?.click();
  await vi.waitFor(() => { expect(row?.querySelector(".card")).not.toBeNull(); });
}

function requestBody(url: string, init?: RequestInit): { operation: string; input: unknown } {
  if (typeof init?.body !== "string") throw new Error("JSON request body missing");
  const envelope = JSON.parse(init.body) as { input: unknown }; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- decoded test request
  return { operation: decodeURIComponent(url.slice(url.lastIndexOf("/") + 1)), input: envelope.input };
}

function sessionIdOf(input: unknown): string | undefined {
  return typeof input === "object" && input !== null && "sessionId" in input && typeof input.sessionId === "string" ? input.sessionId : undefined;
}

function stubService(list: unknown = summaries, inspect: unknown = snapshot, associations: Record<string, unknown> = {}): void {
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const chats = chatsResponse(url);
    if (chats !== undefined) return Promise.resolve(chats);
    const body = requestBody(url, init);
    const sessionId = sessionIdOf(body.input);
    const value = body.operation === "list" ? sessionId === undefined ? list : associations[sessionId] ?? [] : inspect;
    return Promise.resolve(new Response(JSON.stringify({ ok: true, value }), { status: 200 }));
  }));
}

function newChooser(): WorkstreamChooser {
  const element = new WorkstreamChooser();
  element.serviceMachineId = "local";
  element.serviceProjectId = "project";
  element.serviceWorkspaceId = "workspace";
  return element;
}

const active = (sessionId: string) => ({ sessionId, phase: "active" as const, label: "Running bash", at: "2026-09-18T07:30:00.000Z" });

const shadow = (element: WorkstreamChooser): ShadowRoot => { const root = element.shadowRoot; if (root === null) throw new Error("no shadow root"); return root; };
const detailOf = (event: Event): OpenWorkstreamSessionDetail => {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
  if (typeof detail !== "object" || detail === null || !("sessionId" in detail)) throw new Error("not an open-workstream-session event");
  return detail as OpenWorkstreamSessionDetail; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- structural check above
};

beforeEach(() => {
  vi.spyOn(pluginsApi, "plugins").mockResolvedValue({
    lifecycleVersion: 2,
    plugins: [{ id: "pi-workbench", source: "test", scope: "user", machineSpecific: true, enabled: true, discovered: true, conflict: false, server: { state: "active", activeRevision: "revision-1", staleRevision: false, restartRequired: false, disableCommand: "pi-web plugins disable pi-workbench --restart" } }],
    diagnostics: [],
    serverRuntime: { status: "available", terminalMode: "required", restartRequired: false, recovery: { showSafeStart: "pi-web plugins safe-start show", bundledOnly: "pi-web plugins safe-start set bundled-only --restart", noServerPlugins: "pi-web plugins safe-start set none --restart", clearSafeStart: "pi-web plugins safe-start clear --restart" } },
  });
  vi.spyOn(workspacesApi, "workspaces").mockImplementation((projectId) => projectId === "p1" ? Promise.resolve([workspace("w1", "p1", "/repo/me-trial")]) : Promise.reject(new Error("unknown project")));
  stubService();
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Workstream service", () => {
  it("caches the machine lifecycle across watches and exposes coded store details", async () => {
    const lifecycle = vi.mocked(pluginsApi.plugins);
    const context = { machineId: "cache-test-machine", projectId: "project", workspaceId: "workspace" };
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      const body = requestBody(_url, init);
      return Promise.resolve(new Response(JSON.stringify(body.operation === "watch"
        ? { ok: true, value: { mode: "replay", events: [], nextSequence: 42 } }
        : { ok: false, error: { code: "STALE_REVISION", message: "changed", details: { currentRevision: 42 } } }), { status: 200 }));
    }));
    await watchWorkstreams(context, Number.MAX_SAFE_INTEGER);
    await watchWorkstreams(context, 42);
    expect(lifecycle).toHaveBeenCalledTimes(1);
    await expect(appendWorkstream(context, { workstreamId: "ws", expectedRevision: 1, idempotencyKey: "retry", records: [] }))
      .rejects.toMatchObject({ code: "STALE_REVISION", details: { currentRevision: 42 } });
    expect(WorkstreamServiceError.name).toBe("WorkstreamServiceError");
  });
});

describe("WorkstreamChooser", () => {
  it("lists Workstreams newest first and opens the newest session from the re-entry card", async () => {
    const element = newChooser();
    document.body.append(element);
    await vi.waitFor(() => { expect(element.shadowRoot?.querySelectorAll(".row").length).toBe(2); });
    const rows = [...shadow(element).querySelectorAll<HTMLButtonElement>(".row")];
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual([snapshot.title, "Older"]);
    expect(rows[0]?.querySelector(".next")?.textContent).toBe("Waiting on youThomas logs in and asks the five questions.");
    expect(rows[1]?.querySelector(".badge")?.textContent).toBe("Dormant");
    expect(rows[0]?.textContent).not.toContain("open question");
    expect([...shadow(element).querySelectorAll("h3")].map((heading) => heading.textContent.trim())).toEqual(["Embabel 1", "Ungrouped 1"]);
    element.project = "embabel";
    await element.updateComplete;
    expect([...shadow(element).querySelectorAll(".group h3")].map((heading) => heading.textContent.trim())).toEqual(["Embabel 1"]);
    element.project = undefined;
    element.excludeProjects = ["embabel"];
    await element.updateComplete;
    expect([...shadow(element).querySelectorAll(".group h3")].map((heading) => heading.textContent.trim())).toEqual(["Ungrouped 1"]);
    element.excludeProjects = [];
    await element.updateComplete;

    rows[0]?.click();
    await vi.waitFor(() => { expect(element.shadowRoot?.querySelector(".card")).not.toBeNull(); });
    const card = shadow(element).querySelector(".card");
    if (card === null) throw new Error("card missing");
    expect([...card.querySelectorAll("h4")].map((heading) => heading.textContent)).toEqual(["Goal", "Chats"]);
    expect(card.querySelector(".goal")?.textContent).toBe("Teach Me the PhotoQuest API.");
    expect(card.querySelector(".done")?.textContent).toBe("Done when Five questions answered.");
    expect(card.querySelector("[data-task-id]")).toBeNull();
    expect(card.textContent).not.toContain("Two sessions disagree");
    expect([...card.querySelectorAll("summary")].map((summary) => summary.textContent)).toEqual(["History · overview and 3 checkpoints"]);
    expect([...card.querySelectorAll(".session-row")].map((row) => row.getAttribute("data-session-id"))).toEqual(["s-b", "s-a", "s-old", "s-none"]);
    await vi.waitFor(() => { expect([...card.querySelectorAll(".session-title")].map((title) => title.textContent)).toEqual(["Trial login", "Stack review", "cp-old changed.…", "Chat not found in PI WEB"]); });

    const selected = new Promise<OpenWorkstreamSessionDetail>((resolve) => { element.addEventListener("open-workstream-session", (event) => { resolve(detailOf(event)); }, { once: true }); });
    card.querySelector<HTMLButtonElement>('[data-session-id="s-a"]')?.click();
    expect(await selected).toMatchObject({ sessionId: "s-a", directories: ["/repo/me"] });

    const opened = new Promise<OpenWorkstreamSessionDetail>((resolve) => { element.addEventListener("open-workstream-session", (event) => { resolve(detailOf(event)); }, { once: true }); });
    card.querySelector<HTMLButtonElement>("button.primary")?.click();
    expect(await opened).toEqual({ workstreamId: "ws-1", sessionId: "s-b", projectId: "p1", workspaceId: "w1", directories: ["/repo/me-trial"] });

    let started: unknown;
    element.addEventListener("start-workstream-session", (event) => { if (event instanceof CustomEvent) started = event.detail; });
    const start = [...card.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "New session");
    start?.click();
    expect(started).toEqual({ workstreamId: "ws-1", directories: ["/repo/me-trial"], sessionId: "s-b" });
    expect(card.textContent).not.toContain("Copy prompt");
    expect(card.textContent).not.toContain("Continue cp-b");
  });

  it("shows the five newest Chats and folds the older ones", async () => {
    const many: WorkstreamSnapshot = { ...snapshot, sessions: Array.from({ length: 7 }, (_, index) => ({ id: `s-${String(index)}`, status: "active", latestCheckpoint: checkpoint(`cp-${String(index)}`, `2026-09-1${String(index)}T10:00:00.000Z`, "Next") })) };
    stubService(summaries, many);
    const element = newChooser();
    document.body.append(element);
    await vi.waitFor(() => { expect(shadow(element).querySelector(".row")).not.toBeNull(); });
    shadow(element).querySelector<HTMLButtonElement>(".row")?.click();
    await vi.waitFor(() => { expect(shadow(element).querySelector(".card")).not.toBeNull(); });
    const card = shadow(element).querySelector(".card");
    expect([...card?.querySelectorAll(":scope > .session-list > .session-row") ?? []].map((row) => row.getAttribute("data-session-id"))).toEqual(["s-6", "s-5", "s-4", "s-3", "s-2"]);
    const older = card?.querySelector("details.older");
    expect(older?.querySelector("summary")?.textContent).toBe("2 older Chats");
    expect([...older?.querySelectorAll(".session-row") ?? []].map((row) => row.getAttribute("data-session-id"))).toEqual(["s-1", "s-0"]);
  });

  it("offers a selected-workspace continuation for a temporary checkpoint", async () => {
    const stale: WorkstreamSnapshot = { ...snapshot, sessions: [{ id: "old", status: "active", latestCheckpoint: checkpoint("old", "2026-09-22T10:00:00Z", "Continue", ["/private/tmp/pi-context-views-20260909"]) }] };
    stubService(summaries, stale);
    const element = newChooser();
    element.canStartEmpty = true;
    document.body.append(element);
    await vi.waitFor(() => { expect(element.shadowRoot?.querySelector(".row")).not.toBeNull(); });
    element.shadowRoot?.querySelector<HTMLButtonElement>(".row")?.click();
    await vi.waitFor(() => { expect(element.shadowRoot?.querySelector(".card")).not.toBeNull(); });
    let started: unknown;
    element.addEventListener("start-workstream-session", (event) => { if (event instanceof CustomEvent) started = event.detail; });
    [...shadow(element).querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "New session in selected workspace")?.click();
    expect(started).toEqual({ workstreamId: "ws-1", directories: [], sessionId: "old", useSelectedWorkspace: true });
    expect([...shadow(element).querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent === "New session")).toBe(false);
  });

  it("starts an empty Workstream from its project workspace", async () => {
    const empty: WorkstreamSnapshot = {
      ...snapshot,
      id: "ws-empty",
      title: "Port Workbench Chat",
      sessions: [],
      humanTasks: [],
      overview: { goal: "Port the shipped Workbench shell.", doneWhen: "Current upstream passes acceptance.", description: "Port the shell.", history: [], recordedAt: "2026-09-21T00:00:00.000Z" },
    };
    stubService([{ id: empty.id, title: empty.title, group: "Pi Workbench", createdAt: empty.updatedAt, updatedAt: empty.updatedAt, lastCheckpointAt: null, unresolvedHumanTaskCount: 0 }], empty);
    const element = newChooser();
    element.project = "Pi Workbench";
    element.canStartEmpty = true;
    document.body.append(element);
    await vi.waitFor(() => { expect(shadow(element).querySelectorAll(".row")).toHaveLength(1); });

    shadow(element).querySelector<HTMLButtonElement>(".row")?.click();
    await vi.waitFor(() => { expect(shadow(element).querySelector(".card")).not.toBeNull(); });
    const start = [...shadow(element).querySelectorAll<HTMLButtonElement>(".card button")].find((button) => button.textContent === "Start Workstream Chat");
    expect(start).toBeDefined();

    let started: unknown;
    element.addEventListener("start-workstream-session", (event) => { if (event instanceof CustomEvent) started = event.detail; });
    start?.click();
    expect(started).toEqual({ workstreamId: empty.id, directories: [] });
  });

  it("does not offer a second Chat when sessions exist but none has checkpointed", async () => {
    const uncheckpointed: WorkstreamSnapshot = { ...snapshot, sessions: [{ id: "running", status: "active", latestCheckpoint: null }], humanTasks: [] };
    stubService([{ id: uncheckpointed.id, title: uncheckpointed.title, group: "Embabel", createdAt: uncheckpointed.updatedAt, updatedAt: uncheckpointed.updatedAt, lastCheckpointAt: null, unresolvedHumanTaskCount: 0 }], uncheckpointed);
    const element = newChooser();
    element.project = "Embabel";
    element.canStartEmpty = true;
    document.body.append(element);
    await vi.waitFor(() => { expect(shadow(element).querySelectorAll(".row")).toHaveLength(1); });

    shadow(element).querySelector<HTMLButtonElement>(".row")?.click();
    await vi.waitFor(() => { expect(shadow(element).querySelector(".card")).not.toBeNull(); });
    expect(shadow(element).querySelector(".card")?.textContent).toContain("No session has checkpointed yet.");
    expect([...shadow(element).querySelectorAll<HTMLButtonElement>(".card button")].some((button) => button.textContent === "Start Workstream Chat")).toBe(false);

  });

  it("explains a pending launch and permits retry after a reconciled failure", async () => {
    const pending: WorkstreamSnapshot = { ...snapshot, sessions: [{ id: "pending:launch", status: "pending", latestCheckpoint: null }], humanTasks: [] };
    const summary = [{ id: pending.id, title: pending.title, group: "Embabel", createdAt: pending.updatedAt, updatedAt: pending.updatedAt, lastCheckpointAt: null, unresolvedHumanTaskCount: 0 }];
    stubService(summary, pending);
    const element = newChooser();
    element.project = "Embabel";
    element.canStartEmpty = true;
    document.body.append(element);
    await vi.waitFor(() => { expect(shadow(element).querySelectorAll(".row")).toHaveLength(1); });
    shadow(element).querySelector<HTMLButtonElement>(".row")?.click();
    await vi.waitFor(() => { expect(shadow(element).querySelector(".card")?.textContent).toContain("Session launch pending reconciliation"); });
    expect([...shadow(element).querySelectorAll<HTMLButtonElement>(".card button")].some((button) => button.textContent === "Start Workstream Chat")).toBe(false);

    document.body.replaceChildren();
    const failed: WorkstreamSnapshot = { ...pending, sessions: [{ id: "failed:launch", status: "failed", latestCheckpoint: null }] };
    stubService(summary, failed);
    const retry = newChooser();
    retry.project = "Embabel";
    retry.canStartEmpty = true;
    document.body.append(retry);
    await vi.waitFor(() => { expect(shadow(retry).querySelectorAll(".row")).toHaveLength(1); });
    shadow(retry).querySelector<HTMLButtonElement>(".row")?.click();
    await vi.waitFor(() => { expect([...shadow(retry).querySelectorAll<HTMLButtonElement>(".card button")].some((button) => button.textContent === "Start Workstream Chat")).toBe(true); });
  });

  it("does not look up Workstreams or show an indicator when no session is live", async () => {
    const calls: { operation: string; input: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const body = requestBody(url, init);
      calls.push(body);
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value: summaries }), { status: 200 }));
    }));
    const element = newChooser();
    document.body.append(element);

    await vi.waitFor(() => { expect(shadow(element).querySelectorAll(".row")).toHaveLength(2); });
    expect(shadow(element).querySelector(".row .activity-indicator.session")).toBeNull();
    expect(calls.filter((call) => sessionIdOf(call.input) !== undefined)).toHaveLength(0);
  });

  it("marks one collapsed Workstream once for all of its live sessions and caches each lookup", async () => {
    const calls: { operation: string; input: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const body = requestBody(url, init);
      calls.push(body);
      const sessionId = sessionIdOf(body.input);
      const value = sessionId === undefined ? summaries : [summaries[1]];
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value }), { status: 200 }));
    }));
    const element = newChooser();
    element.sessionActivities = { "live-a": active("live-a") };
    document.body.append(element);

    await vi.waitFor(() => { expect(shadow(element).querySelectorAll(".row .activity-indicator.session")).toHaveLength(1); });
    expect(shadow(element).querySelector(".row .activity-indicator.session")?.getAttribute("aria-label")).toBe("Session active");
    expect(calls.filter((call) => sessionIdOf(call.input) !== undefined)).toHaveLength(1);

    element.sessionActivities = { "live-a": active("live-a"), "live-b": active("live-b") };
    await vi.waitFor(() => { expect(calls.filter((call) => sessionIdOf(call.input) !== undefined)).toHaveLength(2); });
    expect(shadow(element).querySelectorAll(".row .activity-indicator.session")).toHaveLength(1);

    element.requestUpdate();
    await element.updateComplete;
    expect(calls.filter((call) => sessionIdOf(call.input) !== undefined)).toHaveLength(2);
  });

  it("leaves a live session with no Workstream unmarked", async () => {
    const element = newChooser();
    element.sessionActivities = { orphan: active("orphan") };
    document.body.append(element);

    await vi.waitFor(() => { expect(shadow(element).querySelectorAll(".row")).toHaveLength(2); });
    await vi.waitFor(() => { expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2); });
    expect(shadow(element).querySelector(".row .activity-indicator.session")).toBeNull();
  });

  it("keeps the Workstream list rendered when a live-session lookup fails", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const body = requestBody(url, init);
      if (sessionIdOf(body.input) !== undefined) return Promise.reject(new Error("lookup unavailable"));
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value: summaries }), { status: 200 }));
    }));
    const element = newChooser();
    element.sessionActivities = { "live-a": active("live-a") };
    document.body.append(element);

    await vi.waitFor(() => { expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2); });
    expect(shadow(element).querySelectorAll(".row")).toHaveLength(2);
    expect(shadow(element).querySelector(".row .activity-indicator.session")).toBeNull();
  });

  it("shows a live indicator only for a session with ongoing activity, and carries the Workstream's colour", async () => {
    stubService(summaries, snapshot, { "s-a": [summaries[1]] });
    const element = newChooser();
    element.sessionActivities = { "s-a": active("s-a") };
    document.body.append(element);
    await vi.waitFor(() => { expect(shadow(element).querySelector(".row")).not.toBeNull(); });
    const row = shadow(element).querySelector<HTMLElement>(".row");
    expect(shadow(element).querySelector<HTMLElement>(".workstream")?.style.getPropertyValue("--workstream-color")).toBe(workstreamAccentColor("ws-1"));
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    expect(row?.querySelector("strong")?.textContent).toBe(snapshot.title);
    expect(row?.querySelector(".identity-mark")?.textContent).toBe("IL");
    expect(row?.querySelector(".identity-mark")?.getAttribute("aria-hidden")).toBe("true");

    row?.click();
    await vi.waitFor(() => { expect(shadow(element).querySelector(".card")).not.toBeNull(); });
    expect(row?.getAttribute("aria-expanded")).toBe("true");
    expect(shadow(element).querySelector(".card")?.getAttribute("aria-label")).toBe(`Re-entry card for ${snapshot.title}`);
    const liveRow = shadow(element).querySelector('[data-session-id="s-a"]');
    const idleRow = shadow(element).querySelector('[data-session-id="s-old"]');
    expect(liveRow?.querySelector(".activity-indicator.session")).not.toBeNull();
    expect(liveRow?.textContent).toContain("Running bash");
    expect(idleRow?.querySelector(".activity-indicator.session")).toBeNull();
  });

  it("shows the missing-overview hint instead of inventing a goal", async () => {
    stubService([{ id: "ws-1", title: "T", group: null, createdAt: snapshot.updatedAt, updatedAt: snapshot.updatedAt, lastCheckpointAt: null, unresolvedHumanTaskCount: 0 }], { ...snapshot, overview: null, humanTasks: [] });
    const element = newChooser();
    document.body.append(element);
    await vi.waitFor(() => { expect(element.shadowRoot?.querySelector(".row")).not.toBeNull(); });
    element.shadowRoot?.querySelector<HTMLButtonElement>(".row")?.click();
    await vi.waitFor(() => { expect(element.shadowRoot?.querySelector(".card")).not.toBeNull(); });
    expect(element.shadowRoot?.querySelector(".card .missing")?.textContent).toContain("write the overview for ws-1");
    expect(element.shadowRoot?.querySelector(".card .goal")).toBeNull();
  });
});

describe("WorkstreamChooser Chat titles", () => {
  const anchoredCard: WorkstreamSnapshot = { ...snapshot, sessions: [
    { id: "anchored-1", status: "active", projectId: "p1", workspaceId: "w1", latestCheckpoint: null },
    { id: "anchored-2", status: "active", machineId: "local", projectId: "p1", workspaceId: "w2", latestCheckpoint: null },
    { id: "loose", status: "active", latestCheckpoint: null },
  ] };

  it("titles anchored Chats from their targeted rows while global and unanchored lookups are held", async () => {
    stubService(summaries, anchoredCard);
    const recent = vi.spyOn(sessionsApi, "recent").mockReturnValue(never());
    const locate = vi.spyOn(sessionsApi, "locate").mockReturnValue(never());
    const workspaces = vi.mocked(workspacesApi.workspaces).mockResolvedValue([workspace("w1", "p1", "/repo/one"), workspace("w2", "p1", "/repo/two")]);
    const sessions = vi.spyOn(sessionsApi, "sessions").mockImplementation((cwd, _machineId, options) => options?.sessionId === undefined
      ? never()
      : Promise.resolve([chat(options.sessionId, `Title ${options.sessionId}`, "2026-09-18T10:40:00.000Z", cwd)]));
    const element = newChooser();
    document.body.append(element);
    await openCard(element);

    await vi.waitFor(() => { expect(titleOf(element, "anchored-1")).toBe("Title anchored-1"); });
    expect(titleOf(element, "anchored-2")).toBe("Title anchored-2");
    expect(titleOf(element, "loose")).toBe("Loading title…");
    expect(recent).not.toHaveBeenCalled();
    expect(workspaces).toHaveBeenCalledTimes(1);
    expect(workspaces).toHaveBeenCalledWith("p1", "local");
    expect(sessions.mock.calls.map(([cwd, machineId, options]) => [cwd, machineId, options?.sessionId])).toEqual([["/repo/one", "local", "anchored-1"], ["/repo/two", "local", "anchored-2"]]);
    expect(locate.mock.calls).toEqual([["loose", "local"]]);

    const opened = new Promise<OpenWorkstreamSessionDetail>((resolve) => { element.addEventListener("open-workstream-session", (event) => { resolve(detailOf(event)); }, { once: true }); });
    shadow(element).querySelector<HTMLButtonElement>('button[data-session-id="anchored-1"]')?.click();
    expect(await opened).toMatchObject({ sessionId: "anchored-1", projectId: "p1", workspaceId: "w1" });
  });

  it("marks each Chat ready on its own when an unanchored lookup finishes later", async () => {
    stubService(summaries, anchoredCard);
    const located = held<{ cwd: string }>();
    vi.spyOn(sessionsApi, "locate").mockReturnValue(located.promise);
    vi.mocked(workspacesApi.workspaces).mockResolvedValue([workspace("w1", "p1", "/repo/one")]);
    vi.spyOn(sessionsApi, "sessions").mockImplementation((cwd, _machineId, options) => cwd === "/repo/one" && options?.sessionId === "anchored-1"
      ? Promise.resolve([chat("anchored-1", "First", "2026-09-18T10:40:00.000Z", cwd)])
      : cwd === "/repo/loose" && options?.sessionId === "loose" ? Promise.resolve([chat("loose", "Loose title", "2026-09-18T10:40:00.000Z", cwd)]) : notFound());
    const element = newChooser();
    document.body.append(element);
    await openCard(element);

    await vi.waitFor(() => { expect(titleOf(element, "anchored-1")).toBe("First"); });
    // anchored-2's workspace is gone, so it waits on the held locate like the unanchored Chat.
    expect(titleOf(element, "anchored-2")).toBe("Loading title…");
    expect(titleOf(element, "loose")).toBe("Loading title…");
    located.resolve({ cwd: "/repo/loose" });
    await vi.waitFor(() => { expect(titleOf(element, "loose")).toBe("Loose title"); });
    await vi.waitFor(() => { expect(titleOf(element, "anchored-2")).toBe("Chat not found in PI WEB"); });
  });

  it("falls back for legacy, moved, and unknown anchors and never applies a row from another id, cwd, or machine", async () => {
    const session = (id: string, anchor: { machineId?: string; projectId?: string; workspaceId?: string } = {}) => ({ id, status: "active", ...anchor, latestCheckpoint: null });
    stubService(summaries, { ...snapshot, sessions: [
      session("legacy", { projectId: "p1", workspaceId: "w1" }),
      session("archived", { projectId: "p1", workspaceId: "w1" }),
      session("moved", { projectId: "p1", workspaceId: "w-gone" }),
      session("unknown-project", { projectId: "p-gone", workspaceId: "w1" }),
      session("stale-anchor", { projectId: "p1", workspaceId: "w1" }),
      session("elsewhere", { machineId: "remote", projectId: "p1", workspaceId: "w1" }),
    ] });
    const status = vi.spyOn(sessionsApi, "status");
    const locate = vi.spyOn(sessionsApi, "locate").mockImplementation((id) => id === "moved" ? Promise.resolve({ cwd: "/repo/moved" }) : id === "stale-anchor" ? Promise.resolve({ cwd: "/repo/me-trial" }) : notFound());
    vi.spyOn(sessionsApi, "sessions").mockImplementation((cwd, _machineId, options) => {
      const at = (id: string, name: string, rowCwd = cwd) => chat(id, name, "2026-09-18T10:40:00.000Z", rowCwd);
      // A legacy daemon ignores sessionId and answers with its whole catalog.
      if (options?.sessionId === "legacy") return Promise.resolve([at("other", "Other Chat"), at("legacy", "Wrong workspace", "/repo/elsewhere"), at("legacy", "Legacy title")]);
      if (options?.sessionId === "archived") return Promise.resolve([{ ...at("archived", "Archived title"), archived: true }]);
      if (options?.sessionId === "moved" && cwd === "/repo/moved") return Promise.resolve([at("moved", "Moved title")]);
      return notFound();
    });
    const element = newChooser();
    document.body.append(element);
    await openCard(element);

    await vi.waitFor(() => { expect(["legacy", "archived", "moved", "unknown-project", "stale-anchor", "elsewhere"].map((id) => titleOf(element, id))).toEqual(["Legacy title", "Archived title", "Moved title", "Chat not found in PI WEB", "Chat not found in PI WEB", "Chat not found in PI WEB"]); });
    expect(locate.mock.calls.map(([id]) => id).sort()).toEqual(["moved", "stale-anchor", "unknown-project"]);
    expect(targetedCalls("stale-anchor")).toHaveLength(1);
    expect(targetedCalls("elsewhere")).toHaveLength(0);
    expect(shadow(element).querySelector('[data-session-id="other"]')).toBeNull();
    expect(status).not.toHaveBeenCalled();
  });

  it("drops a late Workstream inspection after the owner switches cards", async () => {
    const first = held<Response>();
    const other: WorkstreamSnapshot = { ...snapshot, id: "ws-2", title: "Older", sessions: [] };
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const body = requestBody(url, init);
      if (body.operation === "list") return Promise.resolve(Response.json({ ok: true, value: summaries }));
      return body.input !== null && typeof body.input === "object" && "workstreamId" in body.input && body.input.workstreamId === "ws-1" ? first.promise : Promise.resolve(Response.json({ ok: true, value: other }));
    }));
    const element = newChooser();
    document.body.append(element);
    await vi.waitFor(() => { expect(shadow(element).querySelectorAll(".row")).toHaveLength(2); });
    shadow(element).querySelector<HTMLButtonElement>(".row")?.click();
    await openCard(element, "ws-2");
    first.resolve(Response.json({ ok: true, value: snapshot }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;
    expect([...shadow(element).querySelectorAll(".card")].map((card) => card.getAttribute("aria-label"))).toEqual(["Re-entry card for Older"]);
  });

  it("keeps a superseded machine's late list, card, title, and live lookup out of the current view", async () => {
    const localRow = held<SessionInfo[]>();
    const localLive = held<Response>();
    const localList = held<Response>();
    let listCalls = 0;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const body = requestBody(url, init);
      const machine = /machines\/([^/]+)/.exec(url)?.[1] ?? "local";
      if (body.operation === "list" && sessionIdOf(body.input) !== undefined) return machine === "local" ? localLive.promise : Promise.resolve(Response.json({ ok: true, value: [] }));
      if (body.operation === "list") return ++listCalls === 2 ? localList.promise : Promise.resolve(Response.json({ ok: true, value: machine === "local" ? summaries : [summaries[1]] }));
      return Promise.resolve(Response.json({ ok: true, value: anchoredCard }));
    }));
    vi.spyOn(sessionsApi, "locate").mockImplementation(notFound);
    vi.mocked(workspacesApi.workspaces).mockResolvedValue([workspace("w1", "p1", "/repo/one")]);
    vi.spyOn(sessionsApi, "sessions").mockImplementation((_cwd, machineId) => machineId === "local" ? localRow.promise : notFound());
    const element = newChooser();
    element.sessionActivities = { "live-x": active("live-x") };
    document.body.append(element);
    await openCard(element);
    expect(titleOf(element, "anchored-1")).toBe("Loading title…");

    element.serviceWorkspaceId = "other-workspace"; // a second local list, held until after the machine switch
    await element.updateComplete;
    element.serviceMachineId = "remote";
    await vi.waitFor(() => { expect(shadow(element).querySelectorAll(".row")).toHaveLength(1); });
    expect(shadow(element).querySelector(".card")).toBeNull();
    localList.resolve(Response.json({ ok: true, value: summaries }));
    localRow.resolve([chat("anchored-1", "Local title", "2026-09-18T10:40:00.000Z", "/repo/one")]);
    localLive.resolve(Response.json({ ok: true, value: [summaries[1]] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;
    expect(shadow(element).querySelectorAll(".row")).toHaveLength(1);
    expect(shadow(element).querySelector(".row .activity-indicator.session")).toBeNull();

    await openCard(element);
    await vi.waitFor(() => { expect(titleOf(element, "anchored-1")).toBe("Chat not found in PI WEB"); });
    expect(vi.mocked(sessionsApi.sessions).mock.calls.at(-1)?.[1]).toBe("remote");
  });
});

describe("re-entry helpers", () => {
  it("drops temporary checkpoint directories before choosing a launch target", () => {
    expect(directoriesOf(checkpoint("old", "", "", ["/private/tmp/pi-context-views-20260909", "/tmp/plan.md", "/repo/valid"]))).toEqual(["/repo/valid"]);
    expect(directoriesOf(checkpoint("old", "", "", ["/private/tmp/pi-context-views-20260909"]))).toEqual([]);
  });

  it("orders sessions by newest checkpoint and extracts directories", () => {
    expect(latestCheckpoints(snapshot).map((session) => session.id)).toEqual(["s-b", "s-a", "s-old"]);
    expect(directoriesOf(checkpoint("a", "", "", ["/repo/me", "/repo/me/plan.md", "docs/x", "/repo/me"]))).toEqual(["/repo/me"]);
    expect(directoriesOf(checkpoint("a", "", "", ["branch:main", "/repo/me/plan.md", "/repo/me/notes.txt", "docs/x", "/other/todo.md"]))).toEqual(["/repo/me", "/other"]);
    expect(directoriesOf(undefined)).toEqual([]);
    expect(isTemporaryDirectory("/tmp/deleted-worktree")).toBe(true);
    expect(isTemporaryDirectory("/private/tmp/deleted-worktree/notes.md")).toBe(true);
    expect(isTemporaryDirectory("/Users/thomas/workbench")).toBe(false);
    expect(directoriesOf(checkpoint("a", "", "", ["/private/tmp/deleted-worktree", "/repo/me"]))).toEqual(["/repo/me"]);
  });

  it("collects GitHub PRs and issues once, resolving repo#N owners from full URLs", () => {
    const cp = { ...checkpoint("c", "2026-09-18T00:00:00Z", "Merge me#1587 then pi-web#3."), whatChanged: "Opened https://github.com/embabel/me/pull/1587 and https://github.com/x/y/issues/9." };
    expect(referencesOf({ ...snapshot, sessions: [{ id: "s", status: "active", latestCheckpoint: cp }], links: [{ id: "l", kind: "pr", reference: "me#1587" }], overview: null })).toEqual([
      { key: "me#1587", url: "https://github.com/embabel/me/pull/1587", kind: "PR" },
      { key: "y#9", url: "https://github.com/x/y/issues/9", kind: "Issue" },
      { key: "pi-web#3", url: "https://github.com/search?type=issues&q=pi-web%233", kind: "PR or issue" },
    ]);
  });

  it("derives attention: dormant after 7 days, then recorded waitingOn, then the legacy actor", () => {
    const now = new Date("2026-09-20T00:00:00Z").getTime();
    const base = { id: "w", title: "t", group: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "", lastCheckpointAt: "2026-09-19T00:00:00Z", unresolvedHumanTaskCount: 0 };
    expect(attentionOf({ ...base, lastCheckpointAt: "2026-09-12T00:00:00Z", waitingOn: "owner" }, now)).toBe("dormant");
    expect(attentionOf({ ...base, next: "Thomas reviews", waitingOn: "agent" }, now)).toBe("agent");
    expect(attentionOf({ ...base, next: "Thomas reviews", waitingOn: null }, now)).toBe("owner");
    expect(attentionOf({ ...base, next: "Rod must review" }, now)).toBe("external");
    expect(attentionOf({ ...base, next: "Run the tests" }, now)).toBe("agent");
    expect(attentionOf({ ...base, lastCheckpointAt: null, createdAt: "2026-09-19T00:00:00Z" }, now)).toBeUndefined();
  });

  it("matches Workstream groups to project names loosely", () => {
    expect(groupMatchesProject("Pi Workbench", "pi-workbench")).toBe(true);
    expect(groupMatchesProject("Personal", "OneDrive-Personal")).toBe(false);
    expect(groupMatchesProject("Embabel", "Me")).toBe(false);
    expect(groupMatchesProject("Anything", undefined)).toBe(true);
  });

  it("names the actor and cuts to the first clause", () => {
    expect(actor("Thomas reviews")).toBe("Thomas");
    expect(actor("Rod must review")).toBe("Rod");
    expect(actor("Ask Thomas to approve")).toBe("Thomas");
    expect(actor("Run the tests")).toBe("Pia");
    expect(firstClause("First sentence. Second sentence.")).toBe("First sentence.…");
    expect(firstClause("short")).toBe("short");
  });
});

describe("sessionsByActivity (ISSUE-054)", () => {
  it("puts a new checkpoint-less Chat above older checkpointed ones", () => {
    const cp = (recordedAt: string) => ({ id: "c", whatChanged: "x", remains: "y", next: "z", nextSessionPrompt: null, recordedAt });
    const sessions = [
      { id: "01a0eae1-b651-73f2-bee6-8d5d0b9078eb", status: "active", latestCheckpoint: cp("2026-09-29T02:25:28.538Z") },
      { id: "01a0ebf7-5621-772a-ad93-76f3bcc1e384", status: "active", latestCheckpoint: null },
      { id: "legacy-id", status: "active", latestCheckpoint: null },
      { id: "01a0e8ee-f5ca-73f2-bee6-8d3752cb1a96", status: "active", latestCheckpoint: cp("2026-09-29T05:00:00.000Z") },
    ];
    expect(sessionsByActivity(sessions).map((session) => session.id.slice(0, 8))).toEqual(["01a0ebf7", "01a0e8ee", "01a0eae1", "legacy-i"]);
  });
});
