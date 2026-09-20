// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { workstreamForSession, type WorkstreamSnapshot } from "./WorkstreamChooser";
import { WorkstreamContextDrawer } from "./WorkstreamContextDrawer";

const snapshot: WorkstreamSnapshot = {
  id: "ws-current",
  title: "Build the Workbench launcher",
  revision: 4,
  updatedAt: "2026-09-20T18:00:00.000Z",
  closed: false,
  sessions: [{
    id: "session-current",
    status: "active",
    latestCheckpoint: {
      id: "cp-current",
      whatChanged: "The drawer prototype is ready.",
      remains: "Choose a variant.",
      next: "Thomas chooses the preferred drawer.",
      nextSessionPrompt: "Continue the drawer work.",
      recordedAt: "2026-09-20T18:00:00.000Z",
    },
  }],
  humanTasks: [],
  links: [],
  overview: {
    goal: "Restore Workstream context inside Chat.",
    doneWhen: "Thomas can identify the current Workstream without leaving Chat.",
    description: "The Workstream joins project navigation, Chat continuation, and attention state without becoming Chat state.",
    history: ["2026-09-20: prototype reviewed."],
    recordedAt: "2026-09-20T18:00:00.000Z",
  },
};

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("workstreamForSession", () => {
  it("locates through the session-filtered list before inspecting the one matching Workstream", async () => {
    const calls: { operation: string; input: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("missing request body");
      const body = JSON.parse(init.body) as { operation: string; input: unknown }; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- decoded test request
      calls.push(body);
      const value = body.operation === "list" ? [{ id: snapshot.id }] : snapshot;
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value }), { status: 200 }));
    }));

    await expect(workstreamForSession("session-current")).resolves.toEqual(snapshot);
    expect(calls).toEqual([
      { operation: "list", input: { sessionId: "session-current", includeClosed: true } },
      { operation: "inspect", input: { workstreamId: "ws-current" } },
    ]);
  });
});

describe("WorkstreamContextDrawer", () => {
  it("uses the selected pull-down design and reveals the actual overview language", async () => {
    const element = new WorkstreamContextDrawer();
    element.snapshot = snapshot;
    document.body.append(element);
    await element.updateComplete;

    const root = element.shadowRoot;
    const details = root?.querySelector("details");
    expect(details?.querySelector("summary")?.textContent).toContain("Build the Workbench launcher");
    expect(details?.open).toBe(false);
    details?.querySelector("summary")?.click();
    expect(details?.open).toBe(true);
    expect(root?.textContent).toContain("Restore Workstream context inside Chat.");
    expect(root?.textContent).toContain("Done when");
    expect(root?.textContent).toContain("The Workstream joins project navigation");
    expect(root?.textContent).toContain("Thomas chooses the preferred drawer.");
    expect(root?.querySelectorAll(".row > p > .label")).toHaveLength(4);
  });

  it("states when the Chat has no Workstream association", async () => {
    const element = new WorkstreamContextDrawer();
    element.snapshot = null;
    document.body.append(element);
    await element.updateComplete;

    expect(element.shadowRoot?.textContent).toContain("No Workstream associated");
    expect(element.shadowRoot?.querySelector("details")).toBeNull();
  });
});
