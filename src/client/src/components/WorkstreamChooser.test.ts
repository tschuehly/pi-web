// @vitest-environment happy-dom

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkstreamChooser, actor, ago, conflicting, directoriesOf, firstClause, groupMatchesProject, isTemporaryDirectory, latestCheckpoints, sentences, withAnchors, type OpenWorkstreamSessionDetail, type WorkstreamSnapshot } from "./WorkstreamChooser";
import { workstreamAccentColor } from "../workstreamColor";
import { pluginsApi } from "../api/clients";

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

const summaries = [{ id: "ws-2", title: "Older", group: null, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", lastCheckpointAt: "2026-09-01T00:00:00.000Z", unresolvedHumanTaskCount: 0 }, { id: "ws-1", title: snapshot.title, group: "Embabel", createdAt: "2026-08-28T00:00:00.000Z", updatedAt: snapshot.updatedAt, lastCheckpointAt: "2026-09-18T10:31:02.522Z", unresolvedHumanTaskCount: 1 }];

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

describe("WorkstreamChooser", () => {
  it("lists Workstreams newest first and opens the newest session from the re-entry card", async () => {
    const element = newChooser();
    document.body.append(element);
    await vi.waitFor(() => { expect(element.shadowRoot?.querySelectorAll(".row").length).toBe(2); });
    const rows = [...shadow(element).querySelectorAll<HTMLButtonElement>(".row")];
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual([snapshot.title, "Older"]);
    expect(rows[0]?.textContent).toContain("1 open question");
    expect(rows[0]?.textContent).toMatch(/worked on .* · started /);
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
    expect(card.querySelector(".goal")?.textContent).toContain("Teach Me the PhotoQuest API.");
    expect(card.querySelector(".next")?.textContent).toContain("Thomas logs in and asks the five questions.");
    expect(card.querySelector(".next .who")?.textContent).toBe("Thomas");
    expect(card.textContent).toContain("Two sessions disagree.");
    expect(card.textContent).toContain("1 open question for Thomas: Merge order?");
    expect([...card.querySelectorAll("summary")].map((summary) => summary.textContent.replace(summary.querySelector(".peek")?.textContent ?? "", "").trim())).toEqual(["Questions", "Now", "So far", "About", "Continue", "Sessions"]);
    expect(card.querySelector('[data-task-id="t1"]')?.textContent).toContain("cannot be answered here");
    expect(card.querySelector('[data-task-id="t1"] button')).toBeNull();
    const sessionDetails = [...card.querySelectorAll("details")].find((details) => details.querySelector("summary")?.textContent.startsWith("Sessions") === true);
    if (sessionDetails === undefined) throw new Error("sessions missing");
    expect(sessionDetails.querySelector(".peek")?.textContent).toBe(`4 sessions · newest ${ago("2026-09-18T10:31:02.522Z")}`);
    expect([...sessionDetails.querySelectorAll(".session-row")].map((row) => row.getAttribute("data-session-id"))).toEqual(["s-b", "s-a", "s-old", "s-none"]);

    const selected = new Promise<OpenWorkstreamSessionDetail>((resolve) => { element.addEventListener("open-workstream-session", (event) => { resolve(detailOf(event)); }, { once: true }); });
    sessionDetails.querySelector<HTMLButtonElement>('[data-session-id="s-a"]')?.click();
    expect(await selected).toMatchObject({ sessionId: "s-a", directories: ["/repo/me"] });

    const opened = new Promise<OpenWorkstreamSessionDetail>((resolve) => { element.addEventListener("open-workstream-session", (event) => { resolve(detailOf(event)); }, { once: true }); });
    card.querySelector<HTMLButtonElement>("button.primary")?.click();
    expect(await opened).toEqual({ workstreamId: "ws-1", sessionId: "s-b", projectId: "p1", workspaceId: "w1", directories: ["/repo/me-trial"], prompt: "Continue cp-b" });

    let started: unknown;
    element.addEventListener("start-workstream-session", (event) => { if (event instanceof CustomEvent) started = event.detail; });
    const start = [...card.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "New session with prompt");
    start?.click();
    expect(started).toEqual({ workstreamId: "ws-1", prompt: "Continue cp-b", directories: ["/repo/me-trial"], sessionId: "s-b" });
    expect(card.textContent).not.toContain("Copy prompt");
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
    expect(started).toEqual({
      workstreamId: empty.id,
      directories: [],
      prompt: "Goal: Port the shipped Workbench shell.\n\nStart Workstream ws-empty (“Port Workbench Chat”). Done when: Current upstream passes acceptance.",
    });
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
    expect(row?.style.getPropertyValue("--workstream-color")).toBe(workstreamAccentColor("ws-1"));
    expect(row?.getAttribute("aria-pressed")).toBe("false");
    expect(row?.querySelector("strong")?.textContent).toBe(snapshot.title);
    expect(row?.querySelector(".identity-mark")?.textContent).toBe("IL");
    expect(row?.querySelector(".identity-mark")?.getAttribute("aria-hidden")).toBe("true");

    row?.click();
    await vi.waitFor(() => { expect(shadow(element).querySelector(".card")).not.toBeNull(); });
    expect(row?.getAttribute("aria-pressed")).toBe("true");
    const card = shadow(element).querySelector<HTMLElement>(".card");
    expect(card?.style.getPropertyValue("--workstream-color")).toBe(workstreamAccentColor("ws-1"));
    expect(card?.getAttribute("aria-label")).toBe(`Re-entry card for ${snapshot.title}`);
    expect(card?.querySelector(".identity-mark")?.textContent).toBe("IL");
    expect(card?.querySelector(".card-title")?.textContent).toBe(snapshot.title);
    const liveRow = shadow(element).querySelector('[data-session-id="s-a"]');
    const idleRow = shadow(element).querySelector('[data-session-id="s-old"]');
    expect(liveRow?.querySelector(".activity-indicator.session")).not.toBeNull();
    expect(liveRow?.textContent).toContain("Running bash");
    expect(idleRow?.querySelector(".activity-indicator.session")).toBeNull();
  });

  it("answers a typed choice with the inspected revision, then refreshes the card and summary", async () => {
    const typed = {
      ...snapshot,
      humanTasks: [
        { id: "yes-no", title: "Proceed?", detail: "Review the consequence.", status: "pending" as const, answerKind: "yes-no" as const, options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], sourceSessionId: "session-owner" },
        { id: "choice", title: "Choose", status: "pending" as const, answerKind: "choice" as const, options: [{ id: "a", label: "Option A" }], sourceSessionId: null },
        { id: "legacy", title: "Old task", status: "pending" as const, answerKind: null, options: [], sourceSessionId: null },
      ],
    };
    const refreshed = { ...typed, revision: 71, humanTasks: typed.humanTasks.map((task) => task.id === "choice" ? { ...task, status: "answered" as const } : task) };
    const refreshedSummaries = summaries.map((item) => item.id === typed.id ? { ...item, unresolvedHumanTaskCount: 2 } : item);
    const calls: { operation: string; input: unknown }[] = [];
    let listCalls = 0;
    let inspectCalls = 0;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const body = requestBody(url, init);
      calls.push(body);
      if (body.operation === "append") return Promise.resolve(new Response(JSON.stringify({ ok: true, value: { acceptedRevision: 71 } }), { status: 200 }));
      if (body.operation === "list") return Promise.resolve(new Response(JSON.stringify({ ok: true, value: listCalls++ === 0 ? summaries : refreshedSummaries }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value: inspectCalls++ === 0 ? typed : refreshed }), { status: 200 }));
    }));
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");

    const element = newChooser();
    document.body.append(element);
    await vi.waitFor(() => { expect(shadow(element).querySelector(".row")).not.toBeNull(); });
    shadow(element).querySelector<HTMLButtonElement>(".row")?.click();
    await vi.waitFor(() => { expect(shadow(element).querySelector('[data-task-id="choice"]')).not.toBeNull(); });
    const card = shadow(element).querySelector(".card");
    expect(card?.textContent).toContain("Review the consequence.");
    expect([...card?.querySelectorAll<HTMLButtonElement>('[data-task-id="yes-no"] button') ?? []].map((button) => button.textContent)).toEqual(["Yes", "No"]);
    expect(card?.querySelector('[data-task-id="yes-no"] [role="group"]')?.getAttribute("aria-label")).toBe("Proceed?");
    expect(card?.querySelector('[data-task-id="legacy"] button')).toBeNull();
    card?.querySelector<HTMLButtonElement>('[data-task-id="choice"] button')?.click();

    await vi.waitFor(() => { expect(shadow(element).querySelector('[data-task-id="choice"]')).toBeNull(); });
    expect(shadow(element).querySelector('[role="status"]')?.textContent).toBe("Answer recorded.");
    expect(shadow(element).activeElement).toBe(shadow(element).querySelector(".card"));
    expect(calls.find((call) => call.operation === "append")).toEqual({
      operation: "append",
      input: {
        workstreamId: "ws-1",
        expectedRevision: 70,
        idempotencyKey: "task-answer-00000000-0000-4000-8000-000000000001",
        records: [{
          type: "human-task.answered",
          producer: "owner",
          payload: { taskId: "choice", answerId: "answer-00000000-0000-4000-8000-000000000002", answer: { kind: "choice", optionId: "a" } },
        }],
      },
    });
    expect(inspectCalls).toBe(2);
    expect(listCalls).toBe(2);
    expect(shadow(element).querySelector(".row")?.textContent).toContain("2 open questions");
  });

  it("surfaces a stale revision without retrying the answer", async () => {
    const typed = {
      ...snapshot,
      humanTasks: [{ id: "choice", title: "Choose", status: "pending" as const, answerKind: "choice" as const, options: [{ id: "a", label: "Option A" }], sourceSessionId: null }],
    };
    const calls: { operation: string; input: unknown }[] = [];
    vi.stubGlobal("crypto", {});
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const body = requestBody(url, init);
      calls.push(body);
      const response = body.operation === "list"
        ? { ok: true, value: summaries }
        : body.operation === "inspect"
          ? { ok: true, value: typed }
          : { ok: false, error: { code: "STALE_REVISION", message: "expected revision 70 but current revision is 71" } };
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    }));

    const element = newChooser();
    document.body.append(element);
    await vi.waitFor(() => { expect(shadow(element).querySelector(".row")).not.toBeNull(); });
    shadow(element).querySelector<HTMLButtonElement>(".row")?.click();
    await vi.waitFor(() => { expect(shadow(element).querySelector('[data-task-id="choice"]')).not.toBeNull(); });
    shadow(element).querySelector<HTMLButtonElement>('[data-task-id="choice"] button')?.click();

    await vi.waitFor(() => { expect(shadow(element).querySelector(".error")?.textContent).toContain("current revision is 71"); });
    expect(calls.filter((call) => call.operation === "append")).toHaveLength(1);
    expect(shadow(element).querySelector<HTMLButtonElement>('[data-task-id="choice"] button')?.disabled).toBe(false);
  });

  it("rejects blank free text and preserves the exact typed answer", async () => {
    const textSnapshot = {
      ...snapshot,
      humanTasks: [{ id: "text", title: "Explain", status: "pending" as const, answerKind: "free-text" as const, options: [], sourceSessionId: "session-text" }],
    };
    const calls: { operation: string; input: unknown }[] = [];
    let inspectCalls = 0;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const body = requestBody(url, init);
      calls.push(body);
      if (body.operation === "append") return Promise.resolve(new Response(JSON.stringify({ ok: true, value: { acceptedRevision: 71 } }), { status: 200 }));
      if (body.operation === "list") return Promise.resolve(new Response(JSON.stringify({ ok: true, value: summaries }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value: inspectCalls++ === 0 ? textSnapshot : { ...textSnapshot, revision: 71, humanTasks: [] } }), { status: 200 }));
    }));

    const element = newChooser();
    document.body.append(element);
    await vi.waitFor(() => { expect(shadow(element).querySelector(".row")).not.toBeNull(); });
    shadow(element).querySelector<HTMLButtonElement>(".row")?.click();
    await vi.waitFor(() => { expect(shadow(element).querySelector<HTMLInputElement>('input[aria-label="Answer Explain"]')).not.toBeNull(); });
    const input = shadow(element).querySelector<HTMLInputElement>('input[aria-label="Answer Explain"]');
    if (input === null) throw new Error("free-text input missing");
    const form = input.closest("form");
    if (form === null) throw new Error("free-text form missing");
    input.value = "   ";
    form.requestSubmit();
    expect(input.validationMessage).toBe("Enter an answer before submitting.");
    expect(calls.some((call) => call.operation === "append")).toBe(false);

    input.value = "  exact typed answer  ";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    form.requestSubmit();
    await vi.waitFor(() => { expect(calls.some((call) => call.operation === "append")).toBe(true); });
    expect(calls.find((call) => call.operation === "append")).toMatchObject({
      input: {
        expectedRevision: 70,
        records: [{ producer: "owner", sourceSessionId: "session-text", payload: { taskId: "text", answer: { kind: "free-text", text: "  exact typed answer  " } } }],
      },
    });
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
  it("orders sessions by newest checkpoint, detects near-simultaneous conflicts, and extracts directories", () => {
    expect(latestCheckpoints(snapshot).map((session) => session.id)).toEqual(["s-b", "s-a", "s-old"]);
    expect(conflicting(checkpoint("a", "2026-09-18T07:00:00Z", ""), checkpoint("b", "2026-09-18T10:00:00Z", ""))).toBe(true);
    expect(conflicting(checkpoint("a", "2026-09-10T07:00:00Z", ""), checkpoint("b", "2026-09-18T10:00:00Z", ""))).toBe(false);
    expect(directoriesOf(checkpoint("a", "", "", ["/repo/me", "/repo/me/plan.md", "docs/x", "/repo/me"]))).toEqual(["/repo/me"]);
    expect(directoriesOf(checkpoint("a", "", "", ["branch:main", "/repo/me/plan.md", "/repo/me/notes.txt", "docs/x", "/other/todo.md"]))).toEqual(["/repo/me", "/other"]);
    expect(directoriesOf(undefined)).toEqual([]);
    expect(isTemporaryDirectory("/tmp/deleted-worktree")).toBe(true);
    expect(isTemporaryDirectory("/private/tmp/deleted-worktree/notes.md")).toBe(true);
    expect(isTemporaryDirectory("/Users/thomas/workbench")).toBe(false);
    expect(directoriesOf(checkpoint("a", "", "", ["/private/tmp/deleted-worktree", "/repo/me"]))).toEqual(["/repo/me"]);
  });

  it("splits prose into readable sentences without breaking common abbreviations", () => {
    expect(sentences("Done. Use e.g. the sample; A; Then test! OK?"))
      .toEqual(["Done.", "Use e.g. the sample; A;", "Then test!", "OK?"]);
    expect(sentences("  One sentence without punctuation  ")).toEqual(["One sentence without punctuation"]);
  });

  it("wraps durable references as code", () => {
    const host = document.createElement("div");
    render(withAnchors("See https://example.com/x, owner/repo#123, #42, abcdef1, /repo/docs/plan.md and ~/notes."), host);
    expect([...host.querySelectorAll("code")].map((code) => code.textContent)).toEqual([
      "https://example.com/x", "owner/repo#123", "#42", "abcdef1", "/repo/docs/plan.md", "~/notes",
    ]);
    expect(host.textContent).toContain("and ~/notes.");
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
