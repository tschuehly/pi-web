// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { workstreamForSession, type WorkstreamSnapshot } from "./WorkstreamChooser";
import { WorkstreamContextDrawer } from "./WorkstreamContextDrawer";
import { workstreamAccentColor } from "../workstreamColor";

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
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/plugins")) return Promise.resolve(new Response(JSON.stringify({
        lifecycleVersion: 2,
        plugins: [{ id: "pi-workbench", source: "test", scope: "user", machineSpecific: true, enabled: true, discovered: true, conflict: false, server: { state: "active", activeRevision: "revision-1", staleRevision: false, restartRequired: false, disableCommand: "pi-web plugins disable pi-workbench --restart" } }],
        diagnostics: [],
        serverRuntime: { status: "available", terminalMode: "required", restartRequired: false, recovery: { showSafeStart: "pi-web plugins safe-start show", bundledOnly: "pi-web plugins safe-start set bundled-only --restart", noServerPlugins: "pi-web plugins safe-start set none --restart", clearSafeStart: "pi-web plugins safe-start clear --restart" } },
      }), { status: 200 }));
      if (typeof init?.body !== "string") throw new Error("missing request body");
      const body: unknown = JSON.parse(init.body);
      if (typeof body !== "object" || body === null || !("input" in body)) throw new Error("invalid request body");
      const operation = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      calls.push({ operation, input: body.input });
      const value = operation === "list" ? [{ id: snapshot.id }] : snapshot;
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value }), { status: 200 }));
    }));

    await expect(workstreamForSession({ machineId: "local", projectId: "project-1", workspaceId: "workspace-1" }, "session-current")).resolves.toEqual(snapshot);
    expect(calls).toEqual([
      { operation: "list", input: { sessionId: "session-current", includeClosed: true } },
      { operation: "inspect", input: { workstreamId: "ws-current" } },
    ]);
  });
});

describe("WorkstreamContextDrawer", () => {
  it("uses the selected pull-down design and reveals the actual overview language", async () => {
    const element = new WorkstreamContextDrawer();
    element.fallbackTitle = "Unassociated Chat";
    element.snapshot = snapshot;
    document.body.append(element);
    await element.updateComplete;

    const root = element.shadowRoot;
    const details = root?.querySelector("details");
    expect(details?.querySelector("summary")?.textContent).toContain("Build the Workbench launcher");
    expect(root?.textContent).not.toContain("Unassociated Chat");
    expect(details?.open).toBe(false);
    details?.querySelector("summary")?.click();
    expect(details?.open).toBe(true);
    expect(root?.textContent).toContain("Restore Workstream context inside Chat.");
    expect(root?.textContent).toContain("Done when");
    expect(root?.textContent).toContain("The Workstream joins project navigation");
    expect(root?.textContent).toContain("Thomas chooses the preferred drawer.");
    expect(root?.querySelectorAll(".row > .label")).toHaveLength(4);
    expect(details?.style.getPropertyValue("--workstream-color")).toBe(workstreamAccentColor(snapshot.id));
  });

  it("shows the Chat title in the existing status tab when no Workstream is associated", async () => {
    const element = new WorkstreamContextDrawer();
    element.fallbackTitle = "Named Chat";
    element.snapshot = null;
    document.body.append(element);
    await element.updateComplete;

    const tab = element.shadowRoot?.querySelector<HTMLElement>(".tab");
    expect(tab?.textContent).toBe("Named Chat");
    expect(tab?.title).toBe("Named Chat");
    expect(tab?.getAttribute("role")).toBe("status");
    expect(element.shadowRoot?.querySelector("details")).toBeNull();
  });

  it("keeps loading and error states ahead of the fallback title", async () => {
    const element = new WorkstreamContextDrawer();
    element.fallbackTitle = "Named Chat";
    document.body.append(element);
    await element.updateComplete;

    let tab = element.shadowRoot?.querySelector<HTMLElement>(".tab");
    expect(tab?.textContent).toBe("Finding Workstream…");
    expect(tab?.getAttribute("role")).toBe("status");

    element.error = "Workbench bridge unavailable";
    await element.updateComplete;
    tab = element.shadowRoot?.querySelector<HTMLElement>(".tab");
    expect(tab?.textContent).toBe("Workstream unavailable");
    expect(tab?.title).toBe("Workbench bridge unavailable");
    expect(tab?.getAttribute("role")).toBe("status");
  });
});
