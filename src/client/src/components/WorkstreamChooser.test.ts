// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkstreamChooser, WorkstreamServiceError, actor, appendWorkstream, attentionOf, directoriesOf, firstClause, groupMatchesProject, isTemporaryDirectory, latestCheckpoints, referencesOf, sessionsByActivity, watchWorkstreams, type OpenWorkstreamSessionDetail, type WorkstreamSnapshot } from "./WorkstreamChooser";
import { workstreamAccentColor } from "../workstreamColor";
import { pluginsApi } from "../api/clients";

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

// PI WEB session metadata: s-b is recent, s-a is found through its working directory, s-old and s-none are unknown.
const chat = (id: string, name: string | undefined, modified: string) => ({ id, path: `/sessions/${id}.jsonl`, cwd: "/repo/me", ...(name === undefined ? {} : { name }), created: modified, modified, messageCount: 3, firstMessage: "" });
function chatsResponse(url: string): Response | undefined {
  if (url.includes("/sessions/recent")) return Response.json([chat("s-b", "Trial login", "2026-09-18T10:40:00.000Z")]);
  if (url.includes("/sessions/locate/s-a")) return Response.json({ cwd: "/repo/me" });
  if (url.includes("/sessions/locate/")) return new Response("not found", { status: 404 });
  if (url.includes("/sessions?cwd=")) return Response.json([chat("s-a", "Stack review", "2026-09-18T07:30:00.000Z")]);
  return undefined;
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
