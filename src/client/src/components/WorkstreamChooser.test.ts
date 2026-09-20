// @vitest-environment happy-dom

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkstreamChooser, actor, conflicting, directoriesOf, firstClause, groupMatchesProject, latestCheckpoints, sentences, withAnchors, type OpenWorkstreamSessionDetail, type WorkstreamSnapshot } from "./WorkstreamChooser";

const checkpoint = (id: string, recordedAt: string, next: string, references: string[] = []) => ({ id, whatChanged: `${id} changed. More detail.`, remains: "Review", next, nextSessionPrompt: `Continue ${id}`, references, recordedAt });

const snapshot: WorkstreamSnapshot = {
  id: "ws-1", title: "Improve OpenAPI source learning", revision: 70, updatedAt: "2026-09-18T10:31:02.522Z", closed: false,
  sessions: [
    { id: "s-old", status: "active", latestCheckpoint: checkpoint("cp-old", "2026-09-10T08:00:00.000Z", "Pia does old thing") },
    { id: "s-a", status: "active", latestCheckpoint: checkpoint("cp-a", "2026-09-18T07:29:54.464Z", "Thomas reviews the stack", ["/repo/me", "/repo/me/plan.md"]) },
    { id: "s-b", status: "active", projectId: "p1", workspaceId: "w1", latestCheckpoint: checkpoint("cp-b", "2026-09-18T10:31:02.522Z", "Thomas logs in and asks the five questions.", ["/repo/me-trial"]) },
    { id: "s-none", status: "active", latestCheckpoint: null },
  ],
  humanTasks: [{ id: "t1", title: "Merge order?", status: "pending" }, { id: "t2", title: "Done", status: "resolved" }],
  links: [],
  overview: { goal: "Teach Me the PhotoQuest API.", doneWhen: "Five questions answered.", description: "Why and scope.", history: ["2026-09-08: slice 1 merged.", "PR #1283 ready."], recordedAt: "2026-09-20T09:00:00.000Z" },
};

const summaries = [{ id: "ws-2", title: "Older", group: null, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", lastCheckpointAt: "2026-09-01T00:00:00.000Z", unresolvedHumanTaskCount: 0 }, { id: "ws-1", title: snapshot.title, group: "Embabel", createdAt: "2026-08-28T00:00:00.000Z", updatedAt: snapshot.updatedAt, lastCheckpointAt: "2026-09-18T10:31:02.522Z", unresolvedHumanTaskCount: 1 }];

function stubService(list: unknown = summaries, inspect: unknown = snapshot): void {
  vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
    const operation = typeof init?.body === "string" && init.body.includes('"operation":"list"') ? "list" : "inspect";
    return Promise.resolve(new Response(JSON.stringify({ ok: true, value: operation === "list" ? list : inspect }), { status: 200 }));
  }));
}

const shadow = (element: WorkstreamChooser): ShadowRoot => { const root = element.shadowRoot; if (root === null) throw new Error("no shadow root"); return root; };
const detailOf = (event: Event): OpenWorkstreamSessionDetail => {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
  if (typeof detail !== "object" || detail === null || !("sessionId" in detail)) throw new Error("not an open-workstream-session event");
  return detail as OpenWorkstreamSessionDetail; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- structural check above
};

beforeEach(() => { stubService(); });
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("WorkstreamChooser", () => {
  it("lists Workstreams newest first and opens the newest session from the re-entry card", async () => {
    const element = new WorkstreamChooser();
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
    expect([...card.querySelectorAll("summary")].map((summary) => summary.textContent.replace(summary.querySelector(".peek")?.textContent ?? "", "").trim())).toEqual(["Now", "So far", "About", "Continue"]);

    const opened = new Promise<OpenWorkstreamSessionDetail>((resolve) => { element.addEventListener("open-workstream-session", (event) => { resolve(detailOf(event)); }); });
    card.querySelector<HTMLButtonElement>("button.primary")?.click();
    expect(await opened).toEqual({ workstreamId: "ws-1", sessionId: "s-b", projectId: "p1", workspaceId: "w1", directories: ["/repo/me-trial"], prompt: "Continue cp-b" });

    let started: unknown;
    element.addEventListener("start-workstream-session", (event) => { if (event instanceof CustomEvent) started = event.detail; });
    const start = [...card.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "New session with prompt");
    start?.click();
    expect(started).toEqual({ workstreamId: "ws-1", prompt: "Continue cp-b", directories: ["/repo/me-trial"], sessionId: "s-b" });
    expect(card.textContent).not.toContain("Copy prompt");
  });

  it("shows the missing-overview hint instead of inventing a goal", async () => {
    stubService([{ id: "ws-1", title: "T", group: null, createdAt: snapshot.updatedAt, updatedAt: snapshot.updatedAt, lastCheckpointAt: null, unresolvedHumanTaskCount: 0 }], { ...snapshot, overview: null, humanTasks: [] });
    const element = new WorkstreamChooser();
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
